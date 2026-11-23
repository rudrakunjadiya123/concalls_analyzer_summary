import { setTimeout as sleep } from "node:timers/promises";
import { PipelineError, publicError } from "../core/errors.js";
import { retryAfterMs } from "../core/retry.js";
import { systemClock } from "../core/clock.js";
import { sha256 } from "../core/hash.js";
import { decodeJson } from "../db/queries.js";
import { loadExtraction } from "../pdf/artifacts.js";
import { chunkDocument, evidenceUnits, estimateTokens } from "../ai/chunk.js";
import { draftSchema, mappedSchema, selectionSchema } from "../ai/contracts.js";
import { synthesisInput, verifySelection } from "../summary/verify.js";

function strict(schema, payload) {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new PipelineError("AI_SCHEMA_INVALID");
  return parsed.data;
}

function isParticipantTitlePage(page) {
  const { lines, cleaned_text, page_number, quality } = page;
  // A short title page with an explicit management roster contributes no dialogue evidence.
  return (
    page_number <= 3 &&
    quality.columns === 1 &&
    lines.length <= 5 &&
    cleaned_text.length <= 240 &&
    /\bearnings conference call\b/iu.test(cleaned_text) &&
    lines.some(({ text }) =>
      /^management:\s*(?:mr|mrs|ms|dr)\./iu.test(text),
    ) &&
    lines.every(
      ({ text }) =>
        /^["“]?[\p{L}\p{M}. &'-]+\s+Q[1-4]\s+FY\s*\d{2,4}$/iu.test(text) ||
        /^earnings conference call["”]?$/iu.test(text) ||
        /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/iu.test(
          text,
        ) ||
        /^management:\s*(?:mr|mrs|ms|dr)\.[\p{L}\p{M}. –—-]+$/iu.test(text),
    )
  );
}

/** Run bounded, resumable map/synthesis and independent final verification for each transcript version. */
export function createAiWorker({
  repository,
  provider,
  config,
  logger,
  clock = systemClock,
  random = Math.random,
}) {
  const chunkOptions = {
    target: config.AI_CHUNK_TARGET_TOKENS,
    overlap: config.AI_CHUNK_OVERLAP_TOKENS,
    maxTotal: config.MAX_AI_INPUT_TOKENS_PER_DOC,
  };
  async function runSummary(job, context, manifest, excludedPages, signal) {
    const { units, batches } = chunkDocument(manifest, {
      ...chunkOptions,
      excludedPages,
    });
    const mapped = [];
    let outside = 0;
    const budget = {
      reserve: (count) => repository.reserve(job, count),
      report: (estimate, usage) => repository.report(job, estimate, usage),
    };
    async function invoke(method, schema, input, repair = false) {
      signal.throwIfAborted();
      if (provider.isMock || provider.id === "extractive")
        budget.reserve(estimateTokens(input));
      const result = await provider[method]({
        ...input,
        signal,
        budget,
        repair,
      });
      signal.throwIfAborted();
      return strict(schema, result);
    }
    async function format(method, schema, input) {
      try {
        return await invoke(method, schema, input);
      } catch (error) {
        if (
          error.code !== "AI_SCHEMA_INVALID" ||
          !repository.repair(job, "format")
        )
          throw error;
        return invoke(method, schema, input, true);
      }
    }
    const { company, quarter, call_date } = context.trusted.metadata;
    const verifiedMetadata = { company, quarter, call_date };
    for (const chunk of batches) {
      signal.throwIfAborted();
      const hash = sha256(JSON.stringify(chunk));
      let result = repository.cached(job, hash);
      if (!result) {
        result = await format("generateFacts", mappedSchema, {
          chunk,
          context: { ...verifiedMetadata, document_id: manifest.document_id },
        });
        repository.cache(job, hash, result);
      }
      const supplied = new Set(
        chunk.units.filter((unit) => !unit.partial).map(({ id }) => id),
      );
      for (const fact of result.facts) {
        if (supplied.has(fact.unit_id)) mapped.push(fact);
        else outside++;
      }
    }
    const checked = synthesisInput(mapped, units, manifest);
    if (outside) checked.rejected.outside_chunk = outside;
    const input = {
      verifiedFacts: checked.facts,
      verifiedMetadata,
      qaOptions: checked.qaOptions,
    };
    let selection;
    try {
      selection = await format("synthesize", selectionSchema, input);
      verifySelection(selection, checked, units, context.trusted);
    } catch (error) {
      if (
        !["AI_EVIDENCE_UNSUPPORTED", "AI_SCHEMA_INVALID"].includes(
          error.code,
        ) ||
        !selection ||
        !repository.repair(job, "synthesis")
      )
        throw error;
      selection = await format("synthesize", selectionSchema, {
        ...input,
        targeted: true,
      });
      verifySelection(selection, checked, units, context.trusted);
    }
    signal.throwIfAborted();
    repository.saveDraft(job, {
      mapped_facts: mapped,
      selection,
      rejected: checked.rejected,
      trusted: context.trusted,
    });
    logger?.info("ai_draft_verified", {
      stage: "ai",
      job_id: job.id,
      count: checked.facts.length,
    });
  }

  async function process(job, signal) {
    const local = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, local.signal])
      : local.signal;
    const heartbeat = setInterval(
      () => {
        try {
          if (repository.renew(job)) return;
        } catch {
          /* A job without a renewable lease cannot spend or publish. */
        }
        local.abort(new PipelineError("JOB_LEASE_LOST"));
      },
      Math.max(100, Math.min(10_000, (config.WORKER_LEASE_SECONDS * 1000) / 3)),
    ).unref();
    try {
      const context = repository.context(job);
      const extraction = await loadExtraction(context.document, config, active);
      if (
        !extraction ||
        extraction.manifest.clean_text_sha256 !== context.row.clean_text_sha256
      )
        throw new PipelineError("FILE_IO_ERROR", undefined, {
          retryable: true,
        });
      const manifest = extraction.manifest;
      const lowPages = manifest.pages.filter(
        ({ quality }) => quality.reading_order_confidence === "low",
      );
      const excludedPages = lowPages
        .filter(isParticipantTitlePage)
        .map((page) => page.page_number);
      if (
        lowPages.length !== excludedPages.length ||
        (manifest.quality.reading_order_confidence === "low" &&
          !lowPages.length) ||
        manifest.quality.suspected_scanned ||
        manifest.quality.replacement_characters ||
        manifest.quality.image_only_pages
      )
        throw new PipelineError("PDF_LAYOUT_LOW_CONFIDENCE");
      if (excludedPages.length)
        context.trusted.warnings.push("participant_title_page_excluded");
      if (provider.id === "gemini" && config.GEMINI_FACT_MODE === "extractive")
        context.trusted.warnings.push(
          "local_fact_extraction_gemini_highlights",
        );
      if (provider.id === "extractive")
        context.trusted.warnings.push(
          "local_extractive_summary_without_gemini",
        );
      const fingerprint = sha256(
        JSON.stringify({
          revision: context.row.version_number,
          doc: manifest.document_sha256,
          page_map: manifest.clean_sha256,
          text: manifest.clean_text_sha256,
          parser: manifest.extraction_version,
          trusted: context.trusted,
          chunkTarget: chunkOptions.target,
          chunkOverlap: chunkOptions.overlap,
          provider: provider.id,
          model: provider.model,
          prompt: job.run.prompt_version,
          ...(config.GEMINI_FACT_MODE === "extractive"
            ? { factMode: "extractive" }
            : {}),
          ...(excludedPages.length ? { excludedPages } : {}),
          temperature: provider.isMock ? null : config.AI_TEMPERATURE,
        }),
      );
      repository.prepare(job, context, fingerprint);
      if (job.step === "summarize") {
        await runSummary(job, context, manifest, excludedPages, active);
      } else {
        const draft = decodeJson(draftSchema, job.run.draft_json);
        const units = evidenceUnits(manifest);
        const checked = synthesisInput(draft.mapped_facts, units, manifest);
        checked.rejected = { ...checked.rejected, ...draft.rejected };
        const verified = verifySelection(
          draft.selection,
          checked,
          units,
          context.trusted,
        );
        active.throwIfAborted();
        repository.publish(job, context, verified);
        logger?.info("ai_summary_published", {
          stage: "ai",
          job_id: job.id,
          count: verified.evidence.length,
        });
      }
    } catch (error) {
      if (signal?.aborted) {
        repository.release(job);
        return;
      }
      if (local.signal.aborted || error.code === "JOB_LEASE_LOST") return;
      const safe = publicError(error).error;
      const instant = clock.now();
      const retry = error.retryable || !(error instanceof PipelineError);
      const jitter = Math.max(
        100,
        Math.floor(
          random() *
            Math.min(300_000, 3000 * 2 ** Math.min(10, job.attempts - 1)),
        ),
      );
      const requested = retryAfterMs(error.retryAfter, instant);
      const delay = Math.min(86_400_000, Math.max(jitter, requested ?? 0));
      repository.fail(
        job,
        safe,
        retry ? new Date(instant.getTime() + delay) : null,
      );
      logger?.warn("ai_job_failed", {
        stage: "ai",
        job_id: job.id,
        error_code: safe.code,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function drain(signal) {
    repository.enqueueEligible();
    if (
      !provider.status().configured ||
      (provider.isMock && config.DATA_MODE !== "fixture")
    )
      return;
    // A lane does one provider call at a time. Retries stay persisted and do not hold a lane open.
    const lanes = Array.from(
      { length: config.MAX_CONCURRENT_LLM_CALLS },
      async () => {
        while (!signal?.aborted) {
          const job = repository.claim();
          if (!job) return;
          try {
            await process(job, signal);
          } catch (error) {
            if (error.code !== "JOB_LEASE_LOST") throw error;
          }
        }
      },
    );
    const results = await Promise.allSettled(lanes);
    const failed = results.find(({ status }) => status === "rejected");
    if (failed) throw failed.reason;
  }

  return {
    drain,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await drain(signal);
        } catch (error) {
          logger?.error("ai_worker_error", {
            stage: "ai",
            error_code: publicError(error).error.code,
          });
        }
        await sleep(750, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
  };
}
