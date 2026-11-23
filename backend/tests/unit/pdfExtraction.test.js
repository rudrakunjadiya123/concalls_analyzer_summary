import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extractPdf } from "../../src/pdf/extract.js";
import { normalizeCompleteText } from "../../src/pdf/clean.js";
import { classifyTranscript } from "../../src/transcript/classify.js";
import { extractMetadata } from "../../src/transcript/period.js";
import {
  columns,
  makeFixturePdf,
  transcriptPages,
} from "../../scripts/stage3-pdf-fixtures.js";

const pdf = (name) =>
  readFileSync(
    new URL(`../../fixtures/pdf/stage3/${name}.pdf`, import.meta.url),
  );
const filing = {
  id: "fictional-filing",
  source: "FIXTURE",
  raw: { synthetic: true },
  subject: "Earnings conference call transcript",
  description: "",
  filing_published_at: "2026-11-10T00:00:00.000Z",
  call_date_hint: null,
  quarter_hint: null,
};
const company = {
  id: "fictional-company",
  display_name: "Synthetic Test Company",
  fiscal_year_start_month: null,
};

it("preserves source positions, rupees, decimals, negatives and a speaker turn crossing an actual page boundary", async () => {
  const extracted = await extractPdf(pdf("single-column"));
  expect(extracted.page_count).toBe(2);
  expect(extracted.pages.map(({ page_number }) => page_number)).toEqual([1, 2]);
  const [first, second] = extracted.pages;
  expect(first.raw_items.find(({ str }) => str === "₹")).toMatchObject({
    x: 268,
    y: 282,
    transform: [11, 0, 0, 11, 268, 510],
  });
  expect(first.cleaned_text).toContain("₹1,200.00 crore");
  expect(first.cleaned_text).toContain("−2.50%");
  expect(first.lines.find(({ text }) => text.includes("−2.50%")).kind).toBe(
    "table",
  );
  expect(first.raw_text).toContain("SYNTHETIC LAYOUT FIXTURE");
  expect(first.cleaned_text).not.toContain("SYNTHETIC LAYOUT FIXTURE");
  expect(second.cleaned_text).not.toContain("Fictional test document");
  expect(second.lines.map(({ text }) => text)).not.toContain("2");
  const turn = extracted.blocks.find(
    ({ speaker }) => speaker === "Ms. Zoë D’Souza",
  );
  expect(turn).toMatchObject({
    page_start: 1,
    page_end: 2,
    kind: "qa_question",
    text: "Could you explain the basis of the margin change, including the movement in standalone operating profit?",
  });
  expect(turn.line_refs.map(({ page_number }) => page_number)).toEqual([
    1, 1, 2,
  ]);
  const atSecondPage = turn.line_refs.at(-1);
  expect(second.lines[atSecondPage.line_number - 1].text).toContain(
    "standalone operating profit",
  );
  expect(
    extracted.blocks.some(
      ({ kind, speaker }) => kind === "qa_answer" && speaker === "Management",
    ),
  ).toBe(true);
});

it("reconstructs full-width sections and high-confidence left-then-right columns in scrambled content", async () => {
  const result = await extractPdf(pdf("two-columns"));
  const page = result.pages[0];
  expect(page.raw_text.indexOf("Right opening")).toBeLessThan(
    page.raw_text.indexOf("Left opening"),
  );
  expect(page.quality).toMatchObject({
    columns: 2,
    reading_order_confidence: "high",
  });
  expect(page.lines.map(({ text }) => text)).toEqual([
    "Synthetic layout heading spanning the page and both reading columns",
    "Left opening line is read first.",
    "Left middle follows it.",
    "Left closing line is read third.",
    "Right opening line is read fourth.",
    "Right middle follows it.",
    "Right closing line follows it.",
    "Full-width footer paragraph after the columns spans past the central page gutter.",
  ]);
});

it("flags a weak gutter instead of treating an isolated separated row as columns", async () => {
  const e = await extractPdf(makeFixturePdf([[columns[0][0], columns[0][4]]]));
  expect(e.quality.warnings).toContain("layout_low_confidence");
  expect(e.pages[0].quality.columns).toBe(1);
});

it("uses overlapping column bands even when the baselines are staggered", async () => {
  const staggered = columns[0].map(([x, y, text, size]) => [
    x,
    x > 300 ? y - 8 : y,
    text,
    size,
  ]);
  const result = await extractPdf(makeFixturePdf([staggered]));
  const page = result.pages[0];
  expect(page.quality).toMatchObject({
    columns: 2,
    reading_order_confidence: "high",
  });
  expect(page.cleaned_text.indexOf("Left closing")).toBeLessThan(
    page.cleaned_text.indexOf("Right opening"),
  );
});

it("recognizes a standalone name in a Q&A section without guessing the identity of unlabeled text", async () => {
  const result = await extractPdf(
    makeFixturePdf([
      [
        [40, 740, "Question and Answer Session"],
        [40, 715, "This opening paragraph has no known speaker."],
        [40, 684, "Anil Kumar"],
        [40, 662, "Could you describe the separate reporting basis?"],
        [40, 640, "Management: We prepared the two measures separately."],
      ],
    ]),
  );
  expect(result.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        speaker: null,
        text: "This opening paragraph has no known speaker.",
      }),
      expect.objectContaining({ speaker: "Anil Kumar", kind: "qa_question" }),
    ]),
  );
});

it("keeps repeated monetary values and moderator lines even within page margins", async () => {
  const rows = [
    [44, 765, "Moderator: Repeat this disclosure."],
    [44, 25, "Revenue ₹125.00 crore"],
  ];
  const output = await extractPdf(makeFixturePdf([rows, rows]));
  expect(
    output.pages.every((page) =>
      page.cleaned_text.includes("Moderator: Repeat this disclosure."),
    ),
  ).toBe(true);
  expect(
    output.pages.every((page) => page.cleaned_text.includes("₹125.00 crore")),
  ).toBe(true);
});

it("classifies image-only, empty, cover-letter, invitation, presentation, and audio notices honestly", async () => {
  const image = await extractPdf(pdf("scanned-image"));
  expect(image.quality).toMatchObject({
    empty_pages: 1,
    image_only_pages: 1,
    suspected_scanned: true,
  });
  expect(classifyTranscript(image, filing)).toMatchObject({
    reason: "ocr_needed",
  });
  const empty = await extractPdf(pdf("empty"));
  expect(empty.quality).toMatchObject({
    image_only_pages: 0,
    suspected_scanned: false,
  });
  expect(classifyTranscript(empty, filing)).toMatchObject({
    reason: "PDF_TEXT_UNAVAILABLE",
  });
  const cover = await extractPdf(
    readFileSync(
      new URL("../../fixtures/pdf/synthetic-cover-letter.pdf", import.meta.url),
    ),
  );
  expect(classifyTranscript(cover, filing)).toMatchObject({
    role: "cover_letter",
    classification: "needs_document",
  });
  const audio = await extractPdf(pdf("audio-notice"));
  expect(classifyTranscript(audio, filing)).toMatchObject({
    classification: "unsupported",
    reason: "audio_only_waiting_transcript",
  });
  for (const [text, reason] of [
    ["Invitation to earnings call will be held next week", "invitation_only"],
    ["Investor presentation on quarterly results", "presentation_only"],
  ]) {
    expect(
      classifyTranscript(
        await extractPdf(makeFixturePdf([[[40, 720, text]]])),
        filing,
      ),
    ).toMatchObject({
      classification: "excluded",
      reason,
    });
  }
});

it("fails safely on a corrupt file, byte and page limits, and an aborted extraction", async () => {
  await expect(extractPdf(pdf("corrupt"))).rejects.toMatchObject({
    code: "PDF_CORRUPT",
  });
  await expect(
    extractPdf(pdf("single-column"), { maxBytes: 30 }),
  ).rejects.toMatchObject({ code: "PDF_RESOURCE_LIMIT" });
  await expect(
    extractPdf(pdf("long-call"), { maxPages: 30 }),
  ).rejects.toMatchObject({ code: "PDF_TOO_MANY_PAGES" });
  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  await expect(
    extractPdf(pdf("empty"), { signal: controller.signal }),
  ).rejects.toThrow("test cancellation");
});

it("retains every page of a long document and folds only whitespace across whitespace-equivalent pages", async () => {
  const result = await extractPdf(pdf("long-call"));
  expect(result.page_count).toBe(42);
  expect(result.quality.text_pages).toBe(42);
  expect(result.pages[41].cleaned_text).toContain("sample 42");
  expect(
    normalizeCompleteText([{ cleaned_text: "₹1,200.00  crore\n−2.50%" }]),
  ).toBe(
    normalizeCompleteText([
      { cleaned_text: "₹1,200.00" },
      { cleaned_text: "crore\t−2.50%" },
    ]),
  );
  expect(normalizeCompleteText([{ cleaned_text: "−2.50%" }])).not.toBe(
    normalizeCompleteText([{ cleaned_text: "-2.50%" }]),
  );
});

it("requires explicit call dates and a verified fiscal convention before mapping a standalone period", async () => {
  const result = await extractPdf(
    makeFixturePdf(
      transcriptPages({
        title: "Synthetic earnings conference call",
        date: "",
      }),
    ),
  );
  expect(
    extractMetadata(
      result,
      { ...filing, description: "Filing date: 10 November 2026" },
      company,
      [company],
    ),
  ).toMatchObject({
    call_date: null,
    quarter: null,
    period_end: "2026-09-30",
    company_confirmed: true,
  });
  expect(
    extractMetadata(
      result,
      filing,
      { ...company, fiscal_year_start_month: 4 },
      [company],
    ),
  ).toMatchObject({ quarter: "Q2 FY27" });
  expect(
    extractMetadata(
      result,
      filing,
      { ...company, fiscal_year_start_month: 1 },
      [company],
    ),
  ).toMatchObject({ quarter: "Q3 FY26" });
});

it("preserves provenance and nulls conflicting dates, quarters and company identities", async () => {
  const other = { id: "other-company", display_name: "Other Test Company" };
  const result = await extractPdf(
    makeFixturePdf(transcriptPages({ issuer: "Issuer: Other Test Company" })),
  );
  const metadata = extractMetadata(
    result,
    { ...filing, call_date_hint: "2026-10-23", quarter_hint: "Q3 FY27" },
    company,
    [company, other],
  );
  expect(metadata).toMatchObject({
    call_date: null,
    quarter: null,
    company_confirmed: false,
  });
  expect(metadata.warnings).toEqual(
    expect.arrayContaining([
      "company_conflict",
      "call_date_conflict",
      "quarter_conflict",
    ]),
  );
  expect(metadata.metadata_provenance).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "call_date",
        value: "2026-10-26",
        page_number: 1,
        raw_expression: "Call held on 26 October 2026",
      }),
      expect.objectContaining({
        field: "call_date",
        value: "2026-10-23",
        source: "filing_structured",
        source_filing_id: filing.id,
      }),
    ]),
  );
});
