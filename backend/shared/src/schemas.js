import { z } from "zod";
import {
  ACCESS_MODES,
  DATA_MODES,
  EVENT_TYPES,
  POLL_RESULTS,
  SOURCES,
} from "./constants.js";

const text = z.string().trim().min(1);
const line = text.max(4096);
const uuid = z.uuid();
const pageNumber = z.int().positive();
export const utcInstantSchema = z.iso.datetime();
export const dateSchema = z.iso.date();
export const quarterSchema = z.string().regex(/^Q[1-4] FY\d{2}$/u);
export const sourceSchema = z.enum(SOURCES);
export const dataModeSchema = z.enum(DATA_MODES);
// This checks the wire format. The API additionally checks trusted origins and resolved addresses.
export const httpsUrlSchema = z
  .url({ protocol: /^https$/u })
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  });

const nseSymbol = z.string().regex(/^[A-Z0-9][A-Z0-9&.-]{0,29}$/u);
const bseScripCode = z.string().regex(/^\d{6}$/u);
const isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/u);

export const companyIdentitySchema = z.strictObject({
  displayName: text.max(256),
  nseSymbol: nseSymbol.nullable(),
  bseScripCode: bseScripCode.nullable(),
  isin: isin.nullable(),
});

export const rawMetadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => {
    // The serialized byte limit is the same in Node and in a browser.
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024
    );
  }, "Raw metadata exceeds 128 KiB");

/** @typedef {z.infer<typeof normalizedFilingSchema>} NormalizedFiling */
export const normalizedFilingSchema = z
  .strictObject({
    source: sourceSchema,
    originatingExchange: z.enum(["NSE", "BSE"]).optional(),
    sourceFilingId: text.max(256),
    company: companyIdentitySchema,
    subject: line,
    description: z.string().max(16384),
    category: line.nullable(),
    subcategory: line.nullable(),
    publishedAt: utcInstantSchema.nullable(),
    callDateHint: dateSchema.nullable(),
    quarterHint: quarterSchema.nullable(),
    sourceUrl: httpsUrlSchema,
    attachments: z
      .array(
        z.strictObject({
          url: httpsUrlSchema,
          filename: text
            .max(255)
            .refine(
              (value) => !/[/\\:]/u.test(value) && ![".", ".."].includes(value),
            ),
          contentTypeHint: text.max(128).nullable(),
          kindHint: z.enum(["pdf", "xbrl", "audio", "other"]),
        }),
      )
      .max(32),
    raw: rawMetadataSchema,
  })
  .refine(
    ({ source, company }) => {
      if (company.isin) return true;
      if (source === "NSE") return Boolean(company.nseSymbol);
      if (source === "BSE") return Boolean(company.bseScripCode);
      return Boolean(company.nseSymbol || company.bseScripCode);
    },
    {
      path: ["company"],
      message: "Missing source-specific company identifier or ISIN",
    },
  );

/** @typedef {z.infer<typeof pageExtractSchema>} PageExtract */
export const pageExtractSchema = z.strictObject({
  page_number: pageNumber,
  raw_text: z.string(),
  cleaned_text: z.string(),
  lines: z.array(
    z.strictObject({
      text: z.string(),
      x: z.number(),
      y: z.number(),
      kind: z.enum(["line", "table"]).optional(),
      ordered_line: pageNumber.optional(),
    }),
  ),
});

/** @typedef {z.infer<typeof transcriptBlockSchema>} TranscriptBlock */
export const transcriptBlockSchema = z
  .strictObject({
    block_id: text,
    page_start: pageNumber,
    page_end: pageNumber,
    speaker: text.nullable(),
    kind: z.enum([
      "management",
      "qa_question",
      "qa_answer",
      "unattributed",
      "table",
      "heading",
    ]),
    text: z.string().min(1),
    line_refs: z
      .array(
        z.strictObject({ page_number: pageNumber, line_number: pageNumber }),
      )
      .min(1)
      .optional(),
  })
  .refine(({ page_start, page_end }) => page_start <= page_end, {
    path: ["page_end"],
    message: "End page precedes start page",
  });

/** @typedef {z.infer<typeof evidenceFactSchema>} EvidenceFact */
export const evidenceFactSchema = z
  .strictObject({
    fact_id: text,
    category: z.enum([
      "metric",
      "guidance",
      "commentary",
      "segment",
      "risk",
      "qa",
    ]),
    claim: line,
    source_quote: line,
    source_page: pageNumber,
    source_block_ids: z.array(text).min(1),
    speaker: line.nullable(),
    period: line.nullable(),
    metric: z
      .strictObject({
        name: line,
        value_original: line,
        unit: line.nullable(),
        basis: line.nullable(),
        comparison: line.nullable(),
      })
      .nullable(),
    modality: z.enum([
      "historical",
      "forward_looking",
      "hypothetical",
      "analyst_question",
    ]),
    extraction_confidence: z.enum(["high", "medium", "low"]),
  })
  .refine(({ category, metric }) => category !== "metric" || metric !== null, {
    path: ["metric"],
    message: "Metric facts require metric details",
  });

/** @typedef {z.infer<typeof summarySchema>} AssignmentSummary */
export const summarySchema = z.strictObject({
  company: line,
  scrip_code: bseScripCode.nullable(),
  nse_symbol: nseSymbol.nullable(),
  quarter: quarterSchema.nullable(),
  call_date: dateSchema.nullable(),
  source: sourceSchema,
  source_url: httpsUrlSchema.nullable(),
  tldr: z.array(line).min(3).max(5),
  management_commentary: z.array(line),
  guidance: z.array(line),
  segment_performance: z.array(z.strictObject({ segment: line, notes: line })),
  key_metrics: z.array(
    z.strictObject({ metric: line, value: line, context: line }),
  ),
  notable_qa: z.array(
    z.strictObject({ question: line, answer: line, asked_by: line.nullable() }),
  ),
  risks: z.array(line),
});

/** @typedef {z.infer<typeof summaryEventSchema>} SummaryEvent */
export const summaryEventSchema = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.int().positive(),
  event_uuid: uuid,
  type: z.enum(EVENT_TYPES),
  emitted_at: utcInstantSchema,
  data_mode: dataModeSchema,
  data: z.strictObject({
    summary_id: uuid,
    company_id: uuid,
    concall_event_id: uuid,
    revision: z.int().positive(),
    is_mock: z.boolean(),
    summary: summarySchema,
  }),
});

const connectedEventSchema = z.strictObject({
  schema_version: z.literal(1),
  type: z.literal("connected"),
  data: z.strictObject({
    last_event_id: z.int().nonnegative(),
    data_mode: dataModeSchema,
  }),
});
export const eventSchema = z.union([summaryEventSchema, connectedEventSchema]);

/** @typedef {z.infer<typeof publicErrorSchema>} PublicErrorEnvelope */
export const publicErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .max(80),
    message: text.max(256),
  }),
});

export const sourceHealthSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(ACCESS_MODES),
  lastSuccessAt: utcInstantSchema.nullable(),
  status: z.enum(["idle", ...POLL_RESULTS]),
  reason: line.optional(),
});

export const discoveryResultSchema = z.strictObject({
  records: z.array(normalizedFilingSchema),
  complete: z.boolean(),
  fetchedPages: z.int().nonnegative(),
  providerCursor: line.optional(),
  diagnostics: rawMetadataSchema,
});
