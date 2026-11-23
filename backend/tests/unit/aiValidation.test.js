import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { summarySchema } from "@finosauras/shared";
import { createMockProvider } from "../../src/services/ai/mock.js";
import { createGeminiProvider } from "../../src/services/ai/gemini.js";
import {
  chunkDocument,
  estimateTokens,
  evidenceUnits,
} from "../../src/services/ai/chunk.js";
import {
  metricEvidence,
  qaTurns,
  verifyAndConsolidate,
} from "../../src/services/ai/evidence.js";
import { callHeaderEvidence } from "../../src/services/transcript/period.js";
import { selectionSchema } from "../../src/services/ai/contracts.js";
import { extractPdf } from "../../src/services/pdf/extract.js";
import {
  synthesisInput,
  verifySelection,
} from "../../src/services/summary/verify.js";
import { renderMarkdown } from "../../src/services/summary/markdown.js";
import { makeFixturePdf } from "../../scripts/stage3-pdf-fixtures.js";

const config = { target: 6000, overlap: 300, maxTotal: 160_000 };
const fixture = readFileSync(
  new URL("../../fixtures/pdf/stage4/synthetic-call.pdf", import.meta.url),
);
const trusted = {
  metadata: {
    company: "Synthetic Test Company",
    scrip_code: null,
    nse_symbol: null,
    quarter: null,
    call_date: null,
    source: "FIXTURE",
    source_url: null,
  },
  warnings: ["quarter_unconfirmed", "call_date_unconfirmed"],
};

async function verifyFixture(bytes, options = config) {
  const manifest = await extractPdf(bytes);
  const { units, batches } = chunkDocument(manifest, options);
  const provider = createMockProvider();
  const mapped = (
    await Promise.all(batches.map((chunk) => provider.generateFacts({ chunk })))
  ).flatMap(({ facts }) => facts);
  const checked = synthesisInput(mapped, units, manifest);
  const selection = await provider.synthesize({
    verifiedFacts: checked.facts,
    qaOptions: checked.qaOptions,
  });
  return {
    manifest,
    checked,
    batches,
    selection,
    units,
    mapped,
    result: verifySelection(selection, checked, units, trusted),
  };
}

describe("local evidence pipeline", () => {
  it("uses a printed participant roster for standalone labels across page boundaries", async () => {
    const pages = [
      [
        "Earnings Conference Call",
        "C O R P O R A T E P A R T I C I P A N T S:",
        "Avery Rao",
        "Chief Financial Officer",
        "Morgan Das (Emcee)",
        "Corporate Communications",
      ],
      [
        "Morgan Das",
        "The first question is from Casey Patel from Fictional Research.",
        "Casey Patel",
        "How do you expect operating costs to change next year?",
      ],
      [
        "Avery Rao",
        "We expect operating costs to rise from the current level next year.",
        "Our operating margin was 15%.",
      ],
    ];
    const manifest = await extractPdf(
      makeFixturePdf(
        pages.map((lines) =>
          lines.map((text, index) => [40, 725 - index * 28, text]),
        ),
      ),
    );
    const units = evidenceUnits(manifest, {
      rosterLabels: true,
      richerEvidence: true,
    });
    expect(units.every(({ page }) => page > 1)).toBe(true);
    expect(
      units.find(({ text }) => text.startsWith("The first question")),
    ).toMatchObject({
      kind: "unattributed",
      speaker: "Morgan Das",
    });
    expect(
      units.find(({ text }) => text.startsWith("How do you expect")),
    ).toMatchObject({
      kind: "qa_question",
      speaker: "Casey Patel",
      page: 2,
    });
    expect(
      units.find(({ text }) => text.startsWith("We expect")),
    ).toMatchObject({
      kind: "management",
      speaker: "Avery Rao",
      page: 3,
    });
    expect(qaTurns(units, { richerEvidence: true }).pairs.size).toBe(1);
  });

  it("recovers the call heading and named dialogue after a signed cover letter", async () => {
    const pdf = makeFixturePdf([
      [
        [40, 725, "October 28, 2022"],
        [40, 705, "Listing Department"],
        [40, 685, "Chief Manager: Enclosed is the transcript."],
      ],
      [
        [40, 725, "Fictional Bank Limited"],
        [
          40,
          705,
          "Earnings conference call - Quarter ended September 30, 2022 (Q2-2023)",
        ],
        [40, 685, "On October 22, 2022"],
        [40, 645, "Moderator: Welcome to the earnings call."],
        [
          40,
          625,
          "I now hand the conference over to Mr. Avery Rao -- Managing Director.",
        ],
        [40, 605, "Mr. Rao's opening remarks"],
        [
          40,
          585,
          "Profit after tax grew by 37.1% year-on-year to 75.58 billion Rupees.",
        ],
        [
          40,
          545,
          "Moderator: The first question is from the line of Casey Das from Fictional Research.",
        ],
        [
          40,
          505,
          "Casey Das: What level of operating margin do you expect next year?",
        ],
      ],
      [
        [
          40,
          725,
          "Avery Rao: We expect margins to recover toward 14% next year.",
        ],
        [40, 705, "Our new business line is still growing."],
      ],
    ]);
    const manifest = await extractPdf(pdf);
    expect(callHeaderEvidence(manifest, 4)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "call_date",
          value: "2022-10-22",
          page_number: 2,
        }),
        expect.objectContaining({
          field: "quarter",
          value: "Q2 FY23",
          page_number: 2,
        }),
      ]),
    );
    const units = evidenceUnits(manifest, { richerEvidence: true });
    expect(units.every(({ page }) => page > 1)).toBe(true);
    expect(
      units.find(({ text }) => text.startsWith("Profit after tax")),
    ).toMatchObject({
      kind: "management",
      speaker: "Avery Rao",
    });
    expect(qaTurns(units, { richerEvidence: true }).pairs.size).toBe(1);
  });

  it("binds the named metric to its printed current level and preserves currency", () => {
    const quote =
      "Profit after tax grew by 37.1% year-on-year to 75.58 billion Rupees in Q2-2023.";
    const metric = {
      name: "Profit after tax",
      value_original: "75.58 billion Rupees",
      unit: null,
      basis: null,
      comparison: null,
    };
    const options = { richerEvidence: true };
    expect(metricEvidence(quote, metric, options)).toMatchObject({
      period: "Q2-2023",
      metric: {
        value_original: "75.58 billion Rupees",
        comparison: "year-on-year",
      },
    });
    expect(
      metricEvidence(quote, { ...metric, value_original: "37.1%" }, options),
    ).toBeNull();
    expect(
      metricEvidence(
        "Profit after tax was 75.58 billion Rupees versus 70.23 billion Rupees.",
        { ...metric, value_original: "70.23 billion Rupees" },
        options,
      ),
    ).toBeNull();
    expect(
      metricEvidence(
        "Profit after tax and net interest income were 75.58 billion Rupees and 85 billion Rupees.",
        metric,
        options,
      ),
    ).toBeNull();
  });

  it("attributes named executives from comma-delimited introductions in the new local verifier", async () => {
    const manifest = await extractPdf(
      makeFixturePdf([
        [
          [
            40,
            725,
            "Moderator: Welcome to the call with Casey Rao, Executive Director,",
          ],
          [
            40,
            705,
            "and Avery Das, Group Chief Financial Officer, of the fictional issuer.",
          ],
          [40, 665, "Casey Rao: The operating margin was 15%."],
          [40, 625, "Avery Das: Capital spending reached Rs. 20 crore."],
          [40, 585, "Taylor Shah: Could the team discuss capital spending?"],
        ],
      ]),
    );
    const current = evidenceUnits(manifest, { extendedExecutiveTitles: true });
    expect(
      current.find(({ text }) => text.startsWith("The operating margin")),
    ).toMatchObject({
      speaker: "Casey Rao",
      kind: "management",
    });
    expect(
      current.find(({ text }) => text.startsWith("Capital spending")),
    ).toMatchObject({
      speaker: "Avery Das",
      kind: "management",
    });
    expect(
      current.find(({ speaker }) => speaker === "Taylor Shah").kind,
    ).not.toBe("management");
    expect(
      evidenceUnits(manifest).find(({ speaker }) => speaker === "Casey Rao")
        .kind,
    ).toBe("unattributed");
  });

  it("retains exact figures, reporting basis and distinct periods while separating guidance and analyst speculation", async () => {
    const { result } = await verifyFixture(fixture);
    expect(summarySchema.parse(result.summary)).toEqual(result.summary);
    const { key_metrics, guidance, notable_qa, risks } = result.summary;
    expect(key_metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "₹1,200 crore",
          context: expect.stringContaining(
            "Consolidated revenue was ₹1,200 crore in Q2 FY27",
          ),
        }),
        expect.objectContaining({
          value: "₹850 crore",
          context: expect.stringContaining(
            "Standalone revenue was ₹850 crore in Q2 FY27",
          ),
        }),
        expect.objectContaining({
          value: "₹1,050 crore",
          context: expect.stringContaining("in Q1 FY27"),
        }),
        expect.objectContaining({ value: "12.0%" }),
      ]),
    );
    expect(guidance).toEqual([
      "Forward-looking — Management: We expect revenue growth of 10–14% next year.",
    ]);
    expect(notable_qa).toHaveLength(1);
    expect(notable_qa[0]).toMatchObject({
      asked_by: null,
      question: expect.stringContaining("including which entities"),
      answer: expect.stringContaining("includes the fictional subsidiary"),
    });
    expect(risks).toEqual([
      "Management: Supply disruption remains a risk for the Industrial segment.",
    ]);
    const json = JSON.stringify(result.summary);
    expect(json).not.toContain("9999");
    expect(json).not.toContain("20% margin");
    expect(result.summary).toMatchObject({ quarter: null, call_date: null });
    expect(result.report.warnings).toEqual(
      expect.arrayContaining(["quarter_unconfirmed", "call_date_unconfirmed"]),
    );
    expect(
      result.evidence.find(
        (row) =>
          row.claim_path.endsWith(".value") &&
          row.supporting_quote.includes("12.0%"),
      ),
    ).toMatchObject({ page_number: 1, speaker: "Management" });
    expect(
      result.evidence
        .filter((row) => row.claim_path === "notable_qa[0].question")
        .map((row) => row.page_number),
    ).toEqual([1, 2]);
  });

  it("rejects fabricated numerical values, quote substitutions, locations, presenters and period relabeling", async () => {
    const { mapped, units, manifest } = await verifyFixture(fixture);
    const metric = mapped.find(
      (item) => item.metric?.value_original === "12.0%",
    );
    const standalone = mapped.find(
      (item) => item.metric?.value_original === "₹850 crore",
    );
    const qa = mapped.find((item) => item.modality === "analyst_question");
    const result = verifyAndConsolidate(
      [
        { ...metric, metric: { ...metric.metric, value_original: "20%" } },
        { ...metric, claim: "Operating margin was 20% in Q2 FY27." },
        { ...metric, source_quote: "Operating margin was 20% in Q2 FY27." },
        { ...metric, source_page: 2 },
        { ...metric, source_block_ids: ["p1bad"] },
        {
          ...standalone,
          metric: { ...standalone.metric, basis: "consolidated" },
        },
        { ...standalone, period: "Q1 FY27" },
        { ...qa, speaker: "Management", modality: "forward_looking" },
        { ...qa, category: "guidance" },
      ],
      units,
      manifest,
    );
    expect(result.facts).toHaveLength(0);
    expect(result.rejected).toMatchObject({
      numeric_or_reporting_basis: 2,
      invalid_location: 2,
      quote_mismatch: 1,
      unsupported_claim: 1,
      period_mismatch: 1,
      attribution_or_modality: 1,
      unsupported_guidance: 1,
    });
  });

  it("does not turn unlabeled questions into management views and rejects invalid synthesis shapes", async () => {
    const { manifest, units, mapped, checked, selection } =
      await verifyFixture(fixture);
    const original = mapped.find(
      (item) => item.modality === "analyst_question",
    );
    const unlabeled = units.map((unit) =>
      unit.id === original.unit_id
        ? { ...unit, speaker: null, kind: "unattributed" }
        : unit,
    );
    const result = verifyAndConsolidate(
      [
        {
          ...original,
          speaker: null,
          category: "guidance",
          modality: "forward_looking",
        },
      ],
      unlabeled,
      manifest,
    );
    expect(result.rejected).toMatchObject({ attribution_or_modality: 1 });
    expect(() =>
      verifySelection(
        { ...selection, tldr: ["invented-id", ...selection.tldr.slice(1)] },
        checked,
        units,
        trusted,
      ),
    ).toThrow(expect.objectContaining({ code: "AI_EVIDENCE_UNSUPPORTED" }));
    const incomplete = { ...selection };
    delete incomplete.guidance;
    expect(selectionSchema.safeParse(incomplete).success).toBe(false);
    expect(
      selectionSchema.safeParse({ ...selection, health_check: true }).success,
    ).toBe(false);
    expect(() => synthesisInput(mapped.slice(0, 1), units, manifest)).toThrow(
      expect.objectContaining({ code: "AI_INSUFFICIENT_EVIDENCE" }),
    );
    expect(() => chunkDocument(manifest, { ...config, maxTotal: 10 })).toThrow(
      expect.objectContaining({ code: "AI_BUDGET_EXCEEDED" }),
    );
  });

  it("preserves accounting parentheses and leaves guidance empty when management declines to give it", async () => {
    const { result } = await verifyFixture(
      makeFixturePdf([
        [
          [40, 718, "Synthetic Test Company Earnings Conference Call Q2 FY27"],
          [40, 682, "Moderator: Welcome to this fictional test call."],
          [40, 654, "Management: Operating margin was (2.5%) in Q2 FY27."],
          [
            40,
            626,
            "Management: Consolidated revenue was ₹450 crore in Q2 FY27.",
          ],
          [
            40,
            598,
            "Management: We are not providing guidance for the coming year.",
          ],
          [
            40,
            570,
            "Management: Supply disruption remains a risk to operations.",
          ],
        ],
      ]),
    );
    expect(result.summary.guidance).toEqual([]);
    expect(result.summary.key_metrics.map(({ value }) => value)).toContain(
      "(2.5%)",
    );
  });

  it("renders deterministic safe Markdown with all sections and accurate absence semantics", async () => {
    const { result } = await verifyFixture(fixture);
    const markdown = renderMarkdown(result.summary, { isMock: true });
    expect(markdown).toBe(
      renderMarkdown(JSON.parse(JSON.stringify(result.summary)), {
        isMock: true,
      }),
    );
    expect(markdown).toContain("Mock".toLowerCase());
    expect(markdown).toContain("12.0%");
    expect(markdown).toContain("Quarter not confirmed");
    expect(markdown).toContain("## Notable analyst Q&A");
    const hazardous = {
      ...result.summary,
      guidance: [],
      management_commentary: [
        "</script> [click](https://example.invalid/malicious) | row",
      ],
      source_url: null,
    };
    const escaped = renderMarkdown(hazardous);
    expect(escaped).toContain("&lt;/script&gt;");
    expect(escaped).toContain("\\| row");
    expect(escaped).toContain("Not stated in the available transcript");
    expect(escaped).not.toContain("](https://example.invalid/malicious)");
  });

  it("covers 42 PDF pages and preserves a cross-chunk Q&A and end-of-call risk", async () => {
    const pages = Array.from({ length: 42 }, (_, index) => [
      [
        40,
        670,
        `Management: Fictional segment operating review material for page ${index + 1} remains in the source record.`,
      ],
    ]);
    pages[0].unshift([
      40,
      720,
      "Synthetic Test Company Earnings Conference Call Q2 FY27",
    ]);
    pages[19].push(
      [40, 641, "Question and Answer Session"],
      [40, 616, "Analyst: Could you clarify the obligations,"],
    );
    pages[20] = [
      [40, 710, "including the fictional contractual delivery obligation?"],
      [40, 679, "Management: The contract requires local delivery only."],
    ];
    pages[41].push([
      40,
      645,
      "Management: A supply outage remains a significant late-call risk.",
    ]);
    const { batches, result } = await verifyFixture(makeFixturePdf(pages), {
      target: 275,
      overlap: 45,
      maxTotal: 80_000,
    });
    expect(batches.length).toBeGreaterThan(5);
    expect(batches.every((batch) => estimateTokens(batch) <= 275)).toBe(true);
    expect(
      new Set(batches.flatMap(({ units }) => units.map(({ page }) => page)))
        .size,
    ).toBe(42);
    expect(result.summary.notable_qa[0].question).toContain(
      "contractual delivery obligation",
    );
    expect(result.summary.risks[0]).toContain("late-call risk");
    expect(
      result.evidence.find(({ claim_path }) => claim_path === "risks[0]")
        .page_number,
    ).toBe(42);
  });
});

function sdk(response) {
  return {
    models: {
      get: vi.fn().mockResolvedValue({
        supportedActions: ["generateContent"],
        inputTokenLimit: 32_000,
        outputTokenLimit: 8192,
      }),
      generateContent: vi
        .fn()
        .mockResolvedValueOnce({ text: '{"status":"ready"}' })
        .mockImplementation(response),
    },
  };
}

describe("Gemini SDK contract, injected responses only", () => {
  it("uses Gemini to map facts and choose each summary section", async () => {
    const units = [
      "Quarterly revenue rose by 8 percent.",
      "The company opened two plants.",
      "The operating margin reached 20 percent.",
    ].map((text, index) => ({
      id: `unit-${index}`,
      block: "speaker",
      kind: "management",
      speaker: "Management",
      page: 2,
      text,
    }));
    const ids = units.map((_, index) => `gemini-1-${index + 1}`);
    const selection = {
      tldr: [ids[2], ids[0], ids[1]],
      management_commentary: ids,
      guidance: [],
      segment_performance: [],
      key_metrics: [],
      notable_qa: [],
      risks: [],
    };
    const client = sdk(async ({ contents }) => ({
      text: JSON.stringify(
        JSON.parse(contents).units
          ? {
              facts: units.map(({ id }) => ({
                unit_id: id,
                category: "commentary",
                period: null,
                metric: null,
                segment: null,
                modality: "historical",
                extraction_confidence: "high",
              })),
            }
          : selection,
      ),
    }));
    const provider = createGeminiProvider({ model: "test-model", client });
    const mapped = await provider.generateFacts({ chunk: { units } });
    expect(client.models.generateContent).toHaveBeenCalledTimes(2);
    expect(mapped.facts.map(({ fact_id }) => fact_id)).toEqual(ids);
    expect(
      await provider.synthesize({
        verifiedFacts: mapped.facts,
        qaOptions: [],
        verifiedMetadata: {},
      }),
    ).toEqual(selection);
    expect(client.models.generateContent).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(client.models.generateContent.mock.calls[2][0].contents)
        .verifiedFacts,
    ).toEqual(mapped.facts);
  });

  it("probes structured output once and sends independently Zod-checked JSON schemas", async () => {
    const client = sdk(async () => ({
      text: '{"facts":[]}',
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 220, candidatesTokenCount: 12 },
    }));
    const provider = createGeminiProvider({ model: "test-model", client });
    const budget = { reserve: vi.fn(), report: vi.fn() };
    await expect(
      provider.generateFacts({
        chunk: { number: 1, units: [] },
        context: {},
        budget,
      }),
    ).resolves.toEqual({ facts: [] });
    await provider.generateFacts({
      chunk: { number: 2, units: [] },
      context: {},
      budget,
    });
    expect(client.models.get).toHaveBeenCalledOnce();
    expect(client.models.generateContent).toHaveBeenCalledTimes(3);
    expect(client.models.generateContent.mock.calls[1][0].config).toMatchObject(
      {
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object", required: ["facts"] },
        automaticFunctionCalling: { disable: true },
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    );
    const schema =
      client.models.generateContent.mock.calls[1][0].config.responseJsonSchema;
    expect(schema.properties.facts).not.toHaveProperty("maxItems");
    expect(schema.properties.facts.items.properties).not.toHaveProperty(
      "source_page",
    );
    expect(budget.report).toHaveBeenCalledWith(expect.any(Number), {
      input: 220,
      output: 12,
    });
    expect(provider.status()).toMatchObject({ configured: true, probed: true });
  });

  it("uses Gemini's ranking for takeaways and keeps verified findings in their mapped sections", async () => {
    const client = sdk(async () => ({
      text: '{"tldr":[4,2,1,3],"ranked":[2,4],"qa":[1]}',
    }));
    const provider = createGeminiProvider({ model: "test-model", client });
    const verifiedFacts = [
      {
        fact_id: "profit",
        category: "commentary",
        modality: "historical",
        claim: "The bank posted higher profit.",
      },
      {
        fact_id: "retail",
        category: "segment",
        modality: "historical",
        claim: "The retail business grew strongly.",
      },
      {
        fact_id: "funding",
        category: "guidance",
        modality: "forward_looking",
        claim: "We expect deposit costs to rise.",
      },
      {
        fact_id: "analyst",
        category: "qa",
        modality: "analyst_question",
        claim: "Why did the loan mix change?",
      },
    ];
    const qaOptions = [{ question_ids: ["analyst"], answer_ids: ["funding"] }];
    await expect(
      provider.synthesize({
        verifiedFacts,
        verifiedMetadata: {},
        qaOptions,
        richerEvidence: true,
      }),
    ).resolves.toMatchObject({
      tldr: ["retail", "profit", "funding"],
      management_commentary: ["profit"],
      segment_performance: ["retail"],
      guidance: ["funding"],
      notable_qa: qaOptions,
    });
  });

  it("attaches exact local wording and page evidence to a model's unit selection", async () => {
    const candidate = {
      unit_id: "block:1",
      category: "commentary",
      period: null,
      metric: null,
      segment: null,
      modality: "historical",
      extraction_confidence: "high",
    };
    const client = sdk(async () => ({
      text: JSON.stringify({
        facts: [candidate, { ...candidate, unit_id: "unknown" }],
      }),
    }));
    const provider = createGeminiProvider({ model: "test-model", client });
    const units = [
      {
        id: "block:1",
        block: "block",
        page: 7,
        kind: "management",
        speaker: "Management",
        text: "Operating margin reached 20 percent.",
      },
    ];
    const { facts } = await provider.generateFacts({
      chunk: { number: 2, units },
      context: {},
    });
    expect(facts).toEqual([
      {
        ...candidate,
        fact_id: "gemini-2-1",
        claim: units[0].text,
        source_quote: units[0].text,
        source_page: 7,
        source_block_ids: ["block"],
        speaker: "Management",
      },
    ]);
  });

  it.each([
    [{ text: "" }, "AI_SCHEMA_INVALID"],
    [{ text: "{broken" }, "AI_SCHEMA_INVALID"],
    [{ text: '{"other":[]}' }, "AI_SCHEMA_INVALID"],
    [
      { text: '{"facts":[]}', candidates: [{ finishReason: "MAX_TOKENS" }] },
      "AI_CONTEXT_LIMIT",
    ],
  ])(
    "rejects partial, empty or changed SDK output (%#)",
    async (response, code) => {
      const provider = createGeminiProvider({
        model: "test-model",
        client: sdk(async () => response),
      });
      await expect(
        provider.generateFacts({ chunk: {}, context: {} }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("surfaces rate-limit delay without retrying or leaking SDK error text", async () => {
    const upstream = Object.assign(
      new Error(
        '{"error":{"details":[{"retryDelay":"7.5s"}],"message":"private"}}',
      ),
      { status: 429 },
    );
    const client = sdk(async () => {
      throw upstream;
    });
    const provider = createGeminiProvider({ model: "test-model", client });
    await expect(
      provider.generateFacts({ chunk: {}, context: {} }),
    ).rejects.toMatchObject({
      code: "AI_RATE_LIMITED",
      retryable: true,
      retryAfter: "8",
      message: "AI rate limit reached",
    });
    expect(client.models.generateContent).toHaveBeenCalledTimes(2);
  });

  it("times out stalled SDK calls and rejects a model without generateContent capability", async () => {
    const client = sdk(() => new Promise(() => {}));
    const provider = createGeminiProvider({
      model: "test-model",
      client,
      timeoutMs: 20,
    });
    await expect(
      provider.generateFacts({ chunk: {}, context: {} }),
    ).rejects.toMatchObject({ code: "AI_TIMEOUT", retryable: true });
    client.models.get.mockResolvedValueOnce({
      supportedActions: ["embedContent"],
    });
    const other = createGeminiProvider({ model: "embedding-only", client });
    await expect(
      other.generateFacts({ chunk: {}, context: {} }),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  });
});
