import { randomUUID } from "node:crypto";
import {
  discoveryResultSchema,
  eventSchema,
  evidenceFactSchema,
  normalizedFilingSchema,
  pageExtractSchema,
  summarySchema,
  transcriptBlockSchema,
} from "@finosauras/shared";
import { describe, expect, it } from "vitest";
import { parseNormalizedFiling } from "../../src/models/filing.js";

// Synthetic contract examples. These records make no claim about a real filing or earnings call.
const publishedAt = "2026-11-22T18:30:00.000Z";
const sourceUrl = "https://example.invalid/contract-test";
const company = {
  displayName: "Synthetic Test Company",
  nseSymbol: "SYNTEST",
  bseScripCode: "000001",
  isin: null,
};
const filing = {
  source: "NSE",
  sourceFilingId: "synthetic-filing",
  company,
  subject: "Contract test",
  description: "",
  category: null,
  subcategory: null,
  publishedAt,
  callDateHint: null,
  quarterHint: null,
  sourceUrl,
  attachments: [],
  raw: { test: true },
};
const summary = {
  company: company.displayName,
  scrip_code: null,
  nse_symbol: null,
  quarter: null,
  call_date: null,
  source: "FIXTURE",
  source_url: null,
  tldr: [
    "Synthetic test item A",
    "Synthetic test item B",
    "Synthetic test item C",
  ],
  management_commentary: [],
  guidance: [],
  segment_performance: [],
  key_metrics: [],
  notable_qa: [],
  risks: [],
};

describe("shared contracts", () => {
  it("preserves nullable identifiers and does not infer dates or quarters", () => {
    expect(summarySchema.parse(summary)).toEqual(summary);
    expect(parseNormalizedFiling(filing, company)).toMatchObject({
      publishedAt,
      callDateHint: null,
      quarterHint: null,
    });
  });

  it.each([
    { key_metrics: [{ metric: "Metric", value: "Example" }] },
    { notable_qa: [{ question: "Test?", answer: "Test" }] },
    { notable_qa: [{ question: "Test?", answer: null, asked_by: null }] },
    { tldr: ["Only one"] },
    { source_url: "javascript:alert(1)" },
    { call_date: "2026-02-30" },
    { fabricated: true },
  ])("rejects malformed or extraneous summary data %j", (invalid) => {
    expect(summarySchema.safeParse({ ...summary, ...invalid }).success).toBe(
      false,
    );
  });

  it("accepts unknown Q&A speakers when a supported answer exists", () => {
    expect(
      summarySchema.safeParse({
        ...summary,
        notable_qa: [
          {
            question: "Synthetic question?",
            answer: "Synthetic answer.",
            asked_by: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects blank filing IDs, malformed native company identifiers and oversized metadata", () => {
    const invalid = [
      { sourceFilingId: "" },
      { company: { ...company, nseSymbol: null } },
      { company: { ...company, bseScripCode: 1 } },
      { raw: { body: "a".repeat(128 * 1024) } },
      { publishedAt: "2026-11-23T00:00:00+05:30" },
    ];
    for (const changes of invalid) {
      expect(
        normalizedFilingSchema.safeParse({ ...filing, ...changes }).success,
      ).toBe(false);
    }
  });

  it("rejects conflicts even when another identifier matches and rejects name-only matches", () => {
    expect(() =>
      parseNormalizedFiling(filing, { ...company, bseScripCode: "000002" }),
    ).toThrow(expect.objectContaining({ code: "COMPANY_IDENTITY_CONFLICT" }));
    expect(() =>
      parseNormalizedFiling(filing, {
        ...company,
        nseSymbol: null,
        bseScripCode: null,
      }),
    ).toThrow(expect.objectContaining({ code: "UNVERIFIED_COMPANY" }));
  });

  it("requires one-based pages and ordered transcript block page ranges", () => {
    expect(
      pageExtractSchema.safeParse({
        page_number: 0,
        raw_text: "",
        cleaned_text: "",
        lines: [],
      }).success,
    ).toBe(false);
    expect(
      transcriptBlockSchema.safeParse({
        block_id: "p2b1",
        page_start: 2,
        page_end: 1,
        speaker: null,
        kind: "unattributed",
        text: "Synthetic block.",
      }).success,
    ).toBe(false);
    expect(
      evidenceFactSchema.safeParse({
        fact_id: "fact",
        category: "metric",
        claim: "Synthetic claim",
        source_quote: "Test quotation",
        source_page: 1,
        source_block_ids: ["p1b1"],
        speaker: null,
        period: null,
        metric: null,
        modality: "historical",
        extraction_confidence: "high",
      }).success,
    ).toBe(false);
  });

  it("validates complete event summaries and retains incomplete discovery status", () => {
    const event = {
      schema_version: 1,
      event_id: 1,
      event_uuid: randomUUID(),
      type: "summary.created",
      emitted_at: publishedAt,
      data_mode: "fixture",
      data: {
        summary_id: randomUUID(),
        company_id: randomUUID(),
        concall_event_id: randomUUID(),
        revision: 1,
        is_mock: true,
        summary,
      },
    };
    expect(eventSchema.safeParse(event).success).toBe(true);
    expect(
      eventSchema.safeParse({ ...event, data: { ...event.data, summary: {} } })
        .success,
    ).toBe(false);
    expect(
      discoveryResultSchema.parse({
        records: [filing],
        complete: false,
        fetchedPages: 1,
        diagnostics: {},
      }).complete,
    ).toBe(false);
  });
});
