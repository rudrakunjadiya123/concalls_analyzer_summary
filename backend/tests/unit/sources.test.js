import { expect, it, vi } from "vitest";
import { createNseSource } from "../../src/sources/nse.js";
import { createBseSource } from "../../src/sources/bse.js";
import { createLicensedSource } from "../../src/sources/licensed.js";
import { classifyFiling } from "../../src/ingestion/eligibility.js";
import { createSourceHttp } from "../../src/core/source-http.js";
import { fakeAddresses, fixtureJson, response } from "../fixtures/ingestion.js";

const company = {
  displayName: "Synthetic anchor",
  nseSymbol: "INFY",
  bseScripCode: "500209",
  isin: "INE009A01021",
};
const window = {
  from: new Date("2026-10-25T19:00:00Z"),
  to: new Date("2026-10-28T00:00:00Z"),
  company,
};
const endpoint = "https://provider.example.invalid/announcements";
const bsePage1 = fixtureJson("bse/synthetic-page-1");
const bsePage2 = fixtureJson("bse/synthetic-page-2");

it("normalizes known NSE aliases, stable fallback IDs, timestamp variants and valid empty arrays", async () => {
  const base = fixtureJson("nse/synthetic-announcements");
  const aliases = fixtureJson("nse/synthetic-field-variants");
  const json = vi
    .fn()
    .mockResolvedValueOnce(base)
    .mockResolvedValueOnce(aliases)
    .mockResolvedValueOnce(aliases)
    .mockResolvedValue([]);
  const discover = createNseSource({ endpoint, client: { json } });
  const first = await discover(window);
  expect(first.records[0]).toMatchObject({
    publishedAt: "2026-10-26T10:00:00.000Z",
    callDateHint: null,
    quarterHint: null,
  });
  expect(first.records[1].publishedAt).toBe("2026-10-26T10:30:00.000Z");
  expect(new URL(json.mock.calls[0][0]).searchParams.get("from_date")).toBe(
    "26-10-2026",
  );
  const variants = await discover(window);
  expect(variants.records[0].sourceFilingId).toMatch(
    /^fingerprint:[\da-f]{64}$/u,
  );
  expect((await discover(window)).records[0].sourceFilingId).toBe(
    variants.records[0].sourceFilingId,
  );
  expect(variants.records[0]).toMatchObject({
    publishedAt: null,
    raw: { unknownOptionalField: true },
  });
  expect(variants.records[1]).toMatchObject({
    sourceFilingId: "10003",
    publishedAt: "2026-10-26T11:00:00.000Z",
  });
  expect(await discover(window)).toMatchObject({ records: [], complete: true });
  expect(classifyFiling(first.records[0]).classification).toBe("candidate");
  expect(classifyFiling(first.records[1]).classification).toBe("excluded");
  expect(classifyFiling(variants.records[0]).reason).toBe(
    "audio_only_waiting_transcript",
  );
  expect(classifyFiling(variants.records[1]).reason).toBe(
    "correction_candidate",
  );
});

it("rejects a changed NSE shape and a conflicting exchange identity", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({ result: [] })
    .mockResolvedValueOnce([
      {
        ...fixtureJson("nse/synthetic-announcements")[0],
        sm_isin: "INE000A01001",
      },
    ]);
  const discover = createNseSource({ endpoint, client: { json } });
  await expect(discover(window)).rejects.toMatchObject({
    code: "SOURCE_SCHEMA_CHANGED",
  });
  await expect(discover(window)).rejects.toMatchObject({
    code: "COMPANY_IDENTITY_CONFLICT",
  });
});

it("collects all BSE pages using ROWCNT, resolves an authorized plain name and retains BSE provenance", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce(bsePage1)
    .mockResolvedValueOnce(bsePage2);
  const discover = createBseSource({
    endpoint,
    client: { json },
    maxPages: 3,
    attachmentBase: "https://documents.example.invalid/attachments/",
  });
  const result = await discover(window);
  expect(result).toMatchObject({
    complete: true,
    fetchedPages: 2,
    diagnostics: { expectedTotal: 2 },
  });
  expect(
    json.mock.calls.map(([url]) => url.searchParams.get("pageno")),
  ).toEqual(["1", "2"]);
  expect(json.mock.calls[0][0].searchParams.get("strScrip")).toBe("500209");
  expect(json.mock.calls[0][0].searchParams.get("strPrevDate")).toBe(
    "20261026",
  );
  expect(result.records[0]).toMatchObject({
    source: "BSE",
    publishedAt: "2026-10-26T10:00:00.000Z",
  });
  expect(result.records[1]).toMatchObject({
    quarterHint: null,
    callDateHint: null,
    attachments: [
      {
        url: "https://documents.example.invalid/attachments/synthetic-cover-letter.pdf",
        kindHint: "pdf",
      },
      { kindHint: "audio" },
    ],
  });
  expect(classifyFiling(result.records[1])).toMatchObject({
    classification: "candidate",
    reason: "cover_letter_candidate",
    targets: [{ index: 0 }],
  });
});

it.each([
  [{ Table: [] }, null, 3, "bse_invalid_total"],
  [{ Table: [], Table1: [{ ROWCNT: "bad" }] }, null, 3, "bse_invalid_total"],
  [
    bsePage1,
    { Table: [], Table1: [{ ROWCNT: 2 }] },
    3,
    "bse_inconsistent_total",
  ],
  [bsePage1, bsePage1, 2, "bse_duplicate_page_row"],
  [bsePage1, null, 1, "bse_page_cap"],
])(
  "fails closed on inconsistent BSE pagination (%#)",
  async (page1, page2, maxPages, reason) => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const result = await createBseSource({
      endpoint,
      client: { json },
      maxPages,
    })(window);
    expect(result).toMatchObject({
      complete: false,
      records: [],
      diagnostics: { reason },
    });
  },
);

it("allows explicit BSE zero count but never builds unsafe filename paths", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({ Table: [], Table1: [{ ROWCNT: 0 }] })
    .mockResolvedValueOnce({
      Table: [
        {
          ...bsePage2.Table[0],
          ATTACHMENTNAME: "../../private.pdf",
          AUDIO_VIDEO_FILE: null,
        },
      ],
      Table1: [{ ROWCNT: 1 }],
    });
  const discover = createBseSource({
    endpoint,
    client: { json },
    maxPages: 1,
    attachmentBase: "https://files.example.invalid/",
  });
  expect(await discover(window)).toMatchObject({ complete: true, records: [] });
  const bad = (await discover(window)).records[0];
  expect(bad.attachments).toEqual([]);
  expect(classifyFiling(bad).classification).toBe("needs_document");
});

it("validates licensed cursors, requires originating exchange and scopes the provider token", async () => {
  const record = {
    source: "LICENSED",
    originatingExchange: "NSE",
    sourceFilingId: "licensed-synthetic",
    company,
    subject: "Synthetic earnings transcript",
    description: "",
    category: null,
    subcategory: null,
    publishedAt: null,
    callDateHint: null,
    quarterHint: null,
    sourceUrl: "https://nse.example.invalid/filing",
    attachments: [],
    raw: {},
  };
  const json = vi
    .fn()
    .mockResolvedValueOnce({ records: [record], nextCursor: "p2" })
    .mockResolvedValueOnce({
      records: [
        { ...record, sourceFilingId: "second", originatingExchange: "BSE" },
      ],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      records: [{ ...record, originatingExchange: undefined }],
      nextCursor: null,
    });
  const discover = createLicensedSource({
    endpoint,
    client: { json },
    maxPages: 2,
    token: "synthetic-token",
  });
  expect(
    (await discover(window)).records.map(
      (filing) => filing.originatingExchange,
    ),
  ).toEqual(["NSE", "BSE"]);
  expect(json.mock.calls[1][0].searchParams.get("cursor")).toBe("p2");
  expect(json.mock.calls[1][1].token).toBe("synthetic-token");
  await expect(discover(window)).rejects.toMatchObject({
    code: "SOURCE_SCHEMA_CHANGED",
  });
});

it("requests a licensed market-wide page without company filters", async () => {
  const json = vi.fn(async () => ({ records: [], nextCursor: null }));
  const discover = createLicensedSource({
    endpoint:
      endpoint + "?nseSymbol=INFY&bseScripCode=500209&isin=INE009A01021",
    client: { json },
    maxPages: 1,
  });
  await expect(
    discover({ from: window.from, to: window.to }),
  ).resolves.toMatchObject({ complete: true });
  const [{ searchParams }] = json.mock.calls[0];
  expect([...searchParams.keys()]).toEqual(["from", "to"]);
});

it("honors Retry-After and jitter, and stops sending after a 403", async () => {
  let time = 0;
  const sleep = vi.fn(async (ms) => {
    time += ms;
  });
  const open = vi
    .fn()
    .mockImplementationOnce(() => response("busy", 429, { "retry-after": "5" }))
    .mockImplementationOnce(() => response("error", 500))
    .mockImplementationOnce(() => response([]))
    .mockImplementationOnce(() => response("forbidden", 403));
  const block = vi.fn();
  const client = createSourceHttp({
    source: "NSE",
    allowedHosts: [new URL(endpoint).hostname],
    authorized: () => true,
    minGap: 0,
    requestTimeout: 1000,
    attempts: 3,
    resolve: fakeAddresses,
    open,
    clock: { now: () => new Date(time) },
    sleep,
    random: () => 0.5,
    policy: { block },
  });
  expect(await client.json(endpoint)).toEqual([]);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 3000]);
  await expect(client.json(endpoint)).rejects.toMatchObject({
    code: "SOURCE_FORBIDDEN",
  });
  await expect(client.json(endpoint)).rejects.toMatchObject({
    code: "SOURCE_FORBIDDEN",
  });
  expect(open).toHaveBeenCalledTimes(4);
  expect(block).toHaveBeenCalledOnce();
});

it("rejects fake HTML success and malformed JSON without retrying them", async () => {
  const open = vi
    .fn()
    .mockImplementationOnce(() =>
      response("<html>login</html>", 200, { "content-type": "text/html" }),
    )
    .mockImplementationOnce(() => response("{broken"));
  const client = createSourceHttp({
    source: "NSE",
    allowedHosts: [new URL(endpoint).hostname],
    authorized: () => true,
    minGap: 0,
    requestTimeout: 1000,
    attempts: 3,
    resolve: fakeAddresses,
    open,
  });
  await expect(client.json(endpoint)).rejects.toMatchObject({
    code: "SOURCE_SCHEMA_CHANGED",
  });
  await expect(client.json(endpoint)).rejects.toMatchObject({
    code: "SOURCE_SCHEMA_CHANGED",
  });
  expect(open).toHaveBeenCalledTimes(2);
});

it("revalidates DNS after a redirect and keeps licensed credentials on the feed origin", async () => {
  const archive = "archive.example.invalid";
  const resolve = vi.fn(fakeAddresses);
  const open = vi
    .fn()
    .mockImplementationOnce(() =>
      response("", 302, { location: `https://${archive}/page` }),
    )
    .mockImplementationOnce(() => response([]))
    .mockImplementationOnce(() =>
      response("", 302, { location: `https://${archive}/private` }),
    );
  const client = createSourceHttp({
    source: "LICENSED",
    allowedHosts: [new URL(endpoint).hostname, archive],
    authorized: () => true,
    minGap: 0,
    requestTimeout: 1000,
    attempts: 2,
    resolve,
    open,
  });
  expect(await client.json(endpoint, { token: "synthetic-secret" })).toEqual(
    [],
  );
  expect(open.mock.calls[0][1]).toMatchObject({
    address: "93.184.216.34",
    family: 4,
    headers: { authorization: "Bearer synthetic-secret" },
  });
  expect(open.mock.calls[1][1].headers).not.toHaveProperty("authorization");
  resolve.mockImplementation((host) =>
    host === archive
      ? Promise.resolve([{ address: "192.168.1.1", family: 4 }])
      : fakeAddresses(),
  );
  await expect(client.json(endpoint)).rejects.toMatchObject({
    code: "DOWNLOAD_UNSAFE_URL",
  });
  expect(open).toHaveBeenCalledTimes(3);
});
