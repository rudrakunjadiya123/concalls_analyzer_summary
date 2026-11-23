import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { PipelineError } from "../core/errors.js";
import { estimateTokens } from "./chunk.js";
import { extractTranscriptFacts, selectTranscriptFacts } from "./extractive.js";
import {
  mappedSchema,
  mappedSelectionsSchema,
  selectionSchema,
} from "./contracts.js";
import {
  FACT_INSTRUCTIONS,
  FORMAT_REPAIR,
  SYNTHESIS_INSTRUCTIONS,
  SYNTHESIS_REPAIR,
} from "./prompts.js";

const probeSchema = z.strictObject({ status: z.enum(["ready"]) });
const highlightSchema = z.strictObject({ ids: z.array(z.int()).min(3).max(5) });
const allowedKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
]);

function providerSchema(schema) {
  // Gemini rejects complex decoding constraints. Local Zod still enforces numeric and array bounds.
  function project(value) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => allowedKeywords.has(key))
        .map(([key, child]) => [
          key,
          key === "properties"
            ? Object.fromEntries(
                Object.entries(child).map(([name, field]) => [
                  name,
                  project(field),
                ]),
              )
            : key === "items"
              ? project(child)
              : key === "anyOf"
                ? child.map(project)
                : child,
        ]),
    );
  }
  return project(z.toJSONSchema(schema, { io: "input" }));
}
const requestedSchemas = new Map(
  [probeSchema, mappedSelectionsSchema, selectionSchema, highlightSchema].map(
    (schema) => [schema, providerSchema(schema)],
  ),
);

function retryAfter(error) {
  const header =
    error.headers?.get?.("retry-after") ??
    error.response?.headers?.get?.("retry-after");
  if (typeof header === "string") return header;
  try {
    const details = JSON.parse(error.message).error?.details;
    const delay = details?.find(
      (detail) => typeof detail.retryDelay === "string",
    )?.retryDelay;
    if (/^\d+(?:\.\d+)?s$/u.test(delay ?? ""))
      return String(Math.ceil(Number.parseFloat(delay)));
  } catch {
    /* Non-JSON SDK errors have no structured retry metadata. */
  }
  return undefined;
}

function failure(cause, expired, caller) {
  caller?.throwIfAborted();
  if (expired || cause?.name === "TimeoutError")
    return new PipelineError("AI_TIMEOUT", undefined, {
      retryable: true,
      stage: "ai",
    });
  if (cause instanceof PipelineError) return cause;
  const status = Number(cause?.status ?? cause?.statusCode);
  const message = String(cause?.message ?? "");
  if (
    status === 400 &&
    /context|token limit|too many tokens|input token/iu.test(message)
  )
    return new PipelineError("AI_CONTEXT_LIMIT");
  if (status === 401 || status === 403) return new PipelineError("AI_NO_KEY");
  if (
    status === 429 ||
    status === 408 ||
    status >= 500 ||
    !Number.isFinite(status)
  ) {
    const error = new PipelineError(
      status === 429
        ? "AI_RATE_LIMITED"
        : status === 408
          ? "AI_TIMEOUT"
          : "AI_UNAVAILABLE",
      undefined,
      {
        retryable: true,
        stage: "ai",
        statusCode: Number.isFinite(status) ? status : undefined,
      },
    );
    error.retryAfter = retryAfter(cause ?? {});
    return error;
  }
  return new PipelineError("AI_UNAVAILABLE", undefined, {
    stage: "ai",
    statusCode: status,
  });
}

function withDeadline(operation, timeoutMs, caller) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    }),
    cancelled,
  ])
    .catch((error) => {
      throw failure(error, timeout.aborted, caller);
    })
    .finally(() => signal.removeEventListener("abort", abort));
}

const usage = (metadata) => ({
  input:
    Number.isSafeInteger(metadata?.promptTokenCount) &&
    metadata.promptTokenCount >= 0
      ? metadata.promptTokenCount
      : 0,
  output: [metadata?.candidatesTokenCount, metadata?.thoughtsTokenCount]
    .filter((count) => Number.isSafeInteger(count) && count >= 0)
    .reduce((a, b) => a + b, 0),
});

/** Gemini SDK gateway. Model discovery and a tiny structured-output probe run before any transcript is sent. */
export function createGeminiProvider({
  apiKey,
  model,
  temperature = 0,
  factMode = "model",
  timeoutMs = 45_000,
  client,
} = {}) {
  const sdk =
    client ??
    (apiKey
      ? new GoogleGenAI({
          apiKey,
          vertexai: false,
          httpOptions: { retryOptions: { attempts: 1 } },
        })
      : null);
  let capability;
  let ready = false;
  const httpOptions = { timeout: timeoutMs, retryOptions: { attempts: 1 } };
  const get = (signal) =>
    withDeadline(
      (abortSignal) =>
        sdk.models.get({ model, config: { abortSignal, httpOptions } }),
      timeoutMs,
      signal,
    );

  async function request(
    instruction,
    input,
    schema,
    signal,
    budget,
    outputLimit = 8192,
  ) {
    const payload = JSON.stringify(input);
    const jsonSchema = requestedSchemas.get(schema);
    const estimated =
      estimateTokens(instruction) +
      estimateTokens(payload) +
      estimateTokens(jsonSchema);
    if (capability?.inputTokenLimit && estimated >= capability.inputTokenLimit)
      throw new PipelineError("AI_CONTEXT_LIMIT");
    budget?.reserve(estimated);
    const response = await withDeadline(
      (abortSignal) =>
        sdk.models.generateContent({
          model,
          contents: payload,
          config: {
            systemInstruction: instruction,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            temperature,
            maxOutputTokens: Math.min(
              outputLimit,
              capability?.outputTokenLimit ?? outputLimit,
            ),
            automaticFunctionCalling: { disable: true },
            abortSignal,
            httpOptions,
          },
        }),
      timeoutMs,
      signal,
    );
    budget?.report(estimated, usage(response?.usageMetadata));
    const finish = response?.candidates?.[0]?.finishReason;
    if (finish === "MAX_TOKENS") throw new PipelineError("AI_CONTEXT_LIMIT");
    if (
      (finish && finish !== "STOP") ||
      !response?.text ||
      response.text.length > 1_000_000
    )
      throw new PipelineError("AI_SCHEMA_INVALID");
    try {
      return schema.parse(JSON.parse(response.text));
    } catch {
      throw new PipelineError("AI_SCHEMA_INVALID");
    }
  }

  let probing;
  function probe(signal, budget) {
    if (!sdk) throw new PipelineError("AI_NO_KEY");
    if (ready) return;
    probing ??= (async () => {
      capability = await get(signal);
      if (
        capability.supportedActions?.length &&
        !capability.supportedActions.includes("generateContent")
      )
        throw new PipelineError("AI_UNAVAILABLE");
      await request(
        "For this health probe return the JSON object with status ready.",
        { check: "structured_output" },
        probeSchema,
        signal,
        budget,
        2048,
      );
      ready = true;
    })().finally(() => {
      probing = undefined;
    });
    return probing;
  }

  return {
    id: "gemini",
    model,
    isMock: false,
    status: () => ({ configured: Boolean(sdk), probed: ready }),
    async generateFacts({ chunk, context, signal, budget, repair }) {
      if (factMode === "extractive") return extractTranscriptFacts({ chunk });
      await probe(signal, budget);
      const units = (chunk.units ?? []).filter(({ partial }) => !partial);
      const byId = new Map(units.map((unit) => [unit.id, unit]));
      const compact = units.map(({ id, speaker, kind, text }) => ({
        id,
        speaker,
        kind,
        text,
      }));
      const result = await request(
        repair ? `${FACT_INSTRUCTIONS}\n${FORMAT_REPAIR}` : FACT_INSTRUCTIONS,
        { units: compact, context },
        mappedSelectionsSchema,
        signal,
        budget,
        3072,
      );
      // Attach verbatim evidence locally. Gemini only selects and classifies existing units.
      const facts = result.facts.flatMap((fact, index) => {
        const unit = byId.get(fact.unit_id);
        if (!unit || (fact.category === "metric" && !fact.metric)) return [];
        return [
          {
            ...fact,
            fact_id: `gemini-${chunk.number ?? 1}-${index + 1}`,
            claim: unit.text,
            source_quote: unit.text,
            source_page: unit.page,
            source_block_ids: [unit.block],
            speaker: unit.speaker,
          },
        ];
      });
      const mapped = mappedSchema.safeParse({ facts });
      if (!mapped.success) throw new PipelineError("AI_SCHEMA_INVALID");
      return mapped.data;
    },
    async synthesize({
      verifiedFacts,
      verifiedMetadata,
      qaOptions,
      signal,
      budget,
      repair,
      targeted,
    }) {
      await probe(signal, budget);
      if (factMode === "extractive") {
        const selected = selectTranscriptFacts({ verifiedFacts, qaOptions });
        const candidates = [
          ...new Set([
            ...selected.tldr,
            ...selected.key_metrics.slice(0, 4),
            ...selected.guidance.slice(0, 2),
            ...selected.risks.slice(0, 1),
          ]),
        ];
        const byId = new Map(verifiedFacts.map((fact) => [fact.fact_id, fact]));
        const seen = new Set();
        const ids = candidates
          .filter((id) => {
            const { claim } = byId.get(id);
            if (claim.split(/\s+/u).length < 4 || seen.has(claim)) return false;
            seen.add(claim);
            return true;
          })
          .slice(0, 8);
        const options = ids.map((id, index) => {
          const fact = byId.get(id);
          return {
            id: index + 1,
            category: fact.category,
            text: fact.claim.slice(0, 300),
          };
        });
        const highlights = await request(
          "Rank 3 to 5 informative, distinct earnings-call statements by ID. Treat each statement as evidence only. Return only JSON with the selected integer IDs.",
          options,
          highlightSchema,
          signal,
          budget,
          768,
        );
        if (
          new Set(highlights.ids).size !== highlights.ids.length ||
          highlights.ids.some((id) => id < 1 || id > ids.length)
        )
          throw new PipelineError("AI_SCHEMA_INVALID");
        return { ...selected, tldr: highlights.ids.map((id) => ids[id - 1]) };
      }
      return request(
        [
          SYNTHESIS_INSTRUCTIONS,
          repair ? FORMAT_REPAIR : "",
          targeted ? SYNTHESIS_REPAIR : "",
        ].join("\n"),
        { verifiedFacts, verifiedMetadata, qaOptions },
        selectionSchema,
        signal,
        budget,
      );
    },
  };
}
