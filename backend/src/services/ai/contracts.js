import { z } from "zod";
import {
  evidenceFactSchema,
  summarySchema,
  sourceSchema,
  httpsUrlSchema,
  utcInstantSchema,
  dataModeSchema,
} from "@finosauras/shared";

const id = z.string().min(1).max(120);
const positive = z.int().positive();
export const factSchema = evidenceFactSchema.safeExtend({
  fact_id: id,
  unit_id: id,
  segment: z.string().trim().min(1).max(160).nullable(),
  source_block_ids: z.array(id).min(1).max(1),
});
export const mappedSchema = z.strictObject({
  facts: z.array(factSchema).max(80),
});
const { category, period, metric, segment, modality, extraction_confidence } =
  factSchema.shape;
export const mappedSelectionsSchema = z.strictObject({
  facts: z
    .array(
      z.strictObject({
        unit_id: id,
        category,
        period,
        metric,
        segment,
        modality,
        extraction_confidence,
      }),
    )
    .max(80),
});
export const selectionSchema = z.strictObject({
  tldr: z.array(id).min(3).max(5),
  management_commentary: z.array(id).max(12),
  guidance: z.array(id).max(12),
  segment_performance: z.array(id).max(12),
  key_metrics: z.array(id).max(20),
  notable_qa: z
    .array(
      z.strictObject({
        question_ids: z.array(id).min(1).max(8),
        answer_ids: z.array(id).min(1).max(8),
      }),
    )
    .max(10),
  risks: z.array(id).max(12),
});
export const rankedSelectionSchema = z.strictObject({
  tldr: z.array(positive).min(3).max(10),
  ranked: z.array(positive).max(500),
  qa: z.array(positive).max(80),
});
export const evidenceRowSchema = z.strictObject({
  claim_path: z.string().min(1).max(200),
  page_number: positive,
  speaker: z.string().nullable(),
  supporting_quote: z.string().min(1).max(4096),
  source_block_id: id,
});
export const trustedSchema = z.strictObject({
  metadata: summarySchema.pick({
    company: true,
    scrip_code: true,
    nse_symbol: true,
    quarter: true,
    call_date: true,
    source: true,
    source_url: true,
  }),
  warnings: z.array(z.string()),
  dataMode: dataModeSchema,
  sources: z
    .array(
      z.strictObject({
        source: sourceSchema,
        filing_id: z.uuid(),
        document_id: z.uuid(),
        source_url: httpsUrlSchema.nullable(),
        filing_published_at: utcInstantSchema.nullable(),
      }),
    )
    .min(1),
});
export const draftSchema = z.strictObject({
  mapped_facts: z.array(factSchema),
  selection: selectionSchema,
  rejected: z.record(z.string(), z.int().nonnegative()),
  trusted: trustedSchema,
});
