import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { readConfig } from "../../src/config/env.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { seedWatchlist } from "../../src/db/seed.js";
import { startApi } from "../../src/index.js";
import { sha256 } from "../../src/core/hash.js";
import { createIngestionService } from "../../src/ingestion/service.js";
import { createSources } from "../../src/sources/factory.js";
import { downloadDocument } from "../../src/ingestion/download.js";
import { createJobRepository } from "../../src/jobs/repository.js";
import { withPipelineLease } from "../../src/scheduler/lease.js";
import { summaryContext } from "../../src/summary/context.js";
import {
  makeFixturePdf,
  transcriptPages,
} from "../../scripts/stage3-pdf-fixtures.js";
import {
  fakeAddresses,
  fixtureJson,
  pdfBytes,
  response,
} from "../fixtures/ingestion.js";

const prior = "2026-10-26T09:00:00.000Z";
const later = "2026-10-27T09:00:00.000Z";
const origin = "https://documents.example.invalid";
const nseResponse = fixtureJson("nse/synthetic-announcements");
const bsePage1 = fixtureJson("bse/synthetic-page-1");
const bsePage2 = fixtureJson("bse/synthetic-page-2");
let root;
let db;
let time;
const clock = { now: () => new Date(time) };

function config(env = {}) {
  return readConfig({
    DATA_DIR: root,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    SOURCE_MIN_GAP_MS: "0",
    INITIAL_BACKFILL_DAYS: "2",
    MAX_JOB_ATTEMPTS: "2",
    WORKER_LEASE_SECONDS: "3",
    ...env,
  });
}

function direct(env = {}) {
  return config({
    DATA_MODE: "authorized-direct",
    LIVE_POLLING_ENABLED: "true",
    NSE_ACCESS_AUTHORIZED: "true",
    BSE_ACCESS_AUTHORIZED: "true",
    NSE_FEED_URL: "https://nse.example.invalid/announcements",
    BSE_FEED_URL: "https://bse.example.invalid/announcements",
    BSE_ATTACHMENT_BASE_URL: `${origin}/attachments/`,
    NSE_ATTACHMENT_HOSTS: new URL(origin).hostname,
    LIVE_MAX_DOCUMENTS_PER_POLL: "1",
    ...env,
  });
}

function verifiedCompany() {
  // Simulate an independent operator identity check, without claiming an exchange lookup.
  db.prepare(
    "UPDATE companies SET identity_verified_at = ?, isin = ? WHERE nse_symbol = 'INFY'",
  ).run(prior, "INE009A01021");
}

const count = (table) =>
  db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
const ingress = (cfg, open, resolve = fakeAddresses, extra = {}) =>
  createIngestionService(db, cfg, {
    clock,
    network: { open, resolve, ...extra },
  });

const nseTranscript = (id, name, company = "INFY", at = "09:59:00") => ({
  ...nseResponse[0],
  seq_id: id,
  symbol: company,
  attchmntFile: `${origin}/${name}.pdf`,
  an_dt: null,
  exchdisstime: `2026-10-26T${at}Z`,
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "finosauras-ingestion-"));
  time = new Date(later).getTime();
  db = openDatabase(config());
  migrateDatabase(db, { clock });
  seedWatchlist(db, { clock });
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true });
});

it("imports browser-saved PDFs through the shared pipeline with exchange polling off and separate Gemini consent", async () => {
  verifiedCompany();
  const cfg = config({
    DATA_MODE: "authorized-direct",
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key-never-sent",
  });
  // Keep the local workflow under test offline, including when explicit consent is added.
  const provider = {
    id: "gemini",
    model: "offline-test",
    isMock: false,
    status: () => ({ configured: false }),
  };
  const service = createIngestionService(db, cfg, {
    clock,
    aiProvider: provider,
  });
  const filePath = path.join(root, "saved-file.pdf");
  const bytes = makeFixturePdf(transcriptPages());
  writeFileSync(filePath, bytes);
  const input = {
    authorized: true,
    filePath,
    company: "INFY",
    sourceUrl: "https://nsearchives.nseindia.com/corporate/synthetic-test.pdf",
    publishedAt: later,
  };
  expect(await service.importPdf(input)).toMatchObject({
    imported: true,
    source: "NSE",
    sha256: sha256(bytes),
    gemini_authorized: false,
  });
  const transcript = db.prepare("SELECT id FROM transcripts").get();
  expect(() => summaryContext(db, transcript.id, cfg, provider)).toThrow(
    expect.objectContaining({ code: "AI_PROVIDER_RESTRICTED" }),
  );
  expect(
    await service.importPdf({
      ...input,
      sourceUrl:
        "https://www.bseindia.com/xml-data/corpfiling/synthetic-test.pdf",
    }),
  ).toMatchObject({ imported: true, source: "BSE" });
  expect(count("source_filings")).toBe(2);
  expect(count("documents")).toBe(1);
  expect(count("transcripts")).toBe(1);
  expect(await service.importPdf({ ...input, summarize: true })).toMatchObject({
    imported: true,
    gemini_authorized: true,
  });
  expect(count("filing_observations")).toBe(2);
  expect(count("ai_runs")).toBe(0);
  expect(count("summaries")).toBe(0);
  expect(
    summaryContext(db, transcript.id, cfg, provider).trusted.sources,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source_url: input.sourceUrl }),
    ]),
  );
  expect(count("live_poll_cycles")).toBe(0);
  expect(service.status().sources.NSE.enabled).toBe(false);
  // Normalized feed fields and operator-facing metadata never substitute for a stored import receipt.
  db.prepare("DELETE FROM local_pdf_imports").run();
  expect(() => summaryContext(db, transcript.id, cfg, provider)).toThrow(
    expect.objectContaining({ code: "AI_PROVIDER_RESTRICTED" }),
  );
});

it("publishes verified local archive evidence without a model or a fabricated original link", async () => {
  verifiedCompany();
  const cfg = config({
    DATA_MODE: "authorized-direct",
    AI_PROVIDER: "extractive",
  });
  const service = createIngestionService(db, cfg, { clock });
  const filePath = path.join(root, "test-archive.pdf");
  const bytes = makeFixturePdf([
    [
      [40, 745, "National Stock Exchange of India Limited"],
      [40, 705, "Test filing of earnings conference call transcript"],
    ],
    ...transcriptPages(),
  ]);
  writeFileSync(filePath, bytes);
  expect(
    await service.importPdf({
      authorized: true,
      summarize: true,
      filePath,
      company: "INFY",
      archiveExchange: "NSE",
    }),
  ).toMatchObject({ imported: true, gemini_authorized: false });
  const row = db
    .prepare("SELECT ai_provider,is_mock,json_payload FROM summaries")
    .get();
  expect(row).toMatchObject({ ai_provider: "extractive", is_mock: 0 });
  expect(JSON.parse(row.json_payload)).toMatchObject({
    source: "NSE",
    source_url: null,
  });
  expect(count("outbox_events")).toBe(1);
  expect(count("summary_evidence")).toBeGreaterThan(2);
});

it("rejects unauthorized, unverified, untrusted and non-PDF local inputs before persisting a filing", async () => {
  const cfg = config({ DATA_MODE: "authorized-direct" });
  const service = createIngestionService(db, cfg, { clock });
  const filePath = path.join(root, "invalid.pdf");
  writeFileSync(filePath, "<html>Login needed</html>");
  const input = {
    authorized: true,
    filePath,
    company: "INFY",
    sourceUrl: "https://nsearchives.nseindia.com/corporate/synthetic-test.pdf",
  };
  await expect(
    service.importPdf({ ...input, authorized: false }),
  ).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
  await expect(service.importPdf(input)).rejects.toMatchObject({
    code: "UNVERIFIED_COMPANY",
  });
  verifiedCompany();
  await expect(
    service.importPdf({
      ...input,
      sourceUrl: "https://nseindia.com.example.invalid/download.pdf",
    }),
  ).rejects.toMatchObject({ code: "DOWNLOAD_UNSAFE_URL" });
  await expect(service.importPdf(input)).rejects.toMatchObject({
    code: "DOWNLOAD_INVALID_TYPE",
  });
  expect(count("source_filings")).toBe(0);
  expect(count("documents")).toBe(0);
  expect(count("local_pdf_imports")).toBe(0);
});

it("queues all new eligible filings by default across approved sources", async () => {
  time = Date.parse("2026-10-26T10:00:00Z");
  const cfg = direct({ LIVE_MAX_DOCUMENTS_PER_POLL: undefined });
  const service = ingress(cfg, (url) =>
    response(
      url.hostname === "nse.example.invalid"
        ? [nseTranscript("one", "first"), nseTranscript("two", "second")]
        : { Table: [], Table1: [{ ROWCNT: 0 }] },
    ),
  );
  expect(await service.watcher.tick({ automatic: true })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "NSE", queued: 2 }),
    ]),
  );
  expect(service.status().live_poll).toMatchObject({
    new_candidates: 2,
    selected_documents: 2,
    discarded_candidates: 0,
  });
  time += 300_000;
  await service.watcher.tick({ automatic: true });
  expect(count("processing_jobs")).toBe(2);
});

it("can select one market-wide document every five minutes and permanently skip the other candidates", async () => {
  verifiedCompany();
  db.prepare(
    "UPDATE companies SET identity_verified_at = ? WHERE nse_symbol = 'TCS'",
  ).run(prior);
  time = Date.parse("2026-10-26T10:00:00Z");
  const cfg = direct();
  const nse = [
    nseTranscript("old", "old-transcript", "INFY", "09:54:00"),
    {
      ...nseTranscript("one", "shared-transcript", "OUTSIDE"),
      sm_name: "Outside Test Company",
      sm_isin: "INE000A01001",
    },
    nseTranscript("two", "other-transcript"),
    nseTranscript("three", "third-transcript", "TCS"),
    { ...nseTranscript("undated", "undated-transcript"), exchdisstime: null },
  ];
  const bse = {
    Table: [
      {
        ...bsePage1.Table[0],
        NEWSID: "one-bse",
        SCRIP_CD: 599999,
        SLONGNAME: "Outside Test Company",
        ISIN: "INE000A01001",
        ATTACHMENT_URL: `${origin}/shared-transcript.pdf`,
        NEWS_DT: "2026-10-26T09:59:00Z",
      },
    ],
    Table1: [{ ROWCNT: 1 }],
  };
  const open = vi.fn((url) => {
    if (url.origin === origin)
      return response(
        makeFixturePdf(
          transcriptPages({ issuer: "Issuer: Outside Test Company" }),
        ),
      );
    if (url.hostname === "nse.example.invalid") {
      const symbol = url.searchParams.get("symbol");
      return response(
        symbol ? nse.filter((row) => row.symbol === symbol) : nse,
      );
    }
    return response(
      url.searchParams.get("strScrip") === ""
        ? bse
        : { Table: [], Table1: [{ ROWCNT: 0 }] },
    );
  });
  const service = ingress(cfg, open);
  const scan = () => service.watcher.tick({ automatic: true });
  const status = () => service.status().live_poll;
  const queued = (outcomes) =>
    outcomes.reduce((total, row) => total + row.queued, 0);

  expect(queued(await scan())).toBe(1);
  expect(status()).toMatchObject({
    interval_seconds: 300,
    result: "success",
    new_candidates: 3,
    selected_documents: 1,
    discarded_candidates: 2,
  });
  expect(count("source_filings")).toBe(4);
  expect(count("download_targets")).toBe(4);
  expect(count("processing_jobs")).toBe(1);
  expect(open.mock.calls).toHaveLength(2);
  expect(open.mock.calls[0][0].searchParams.has("symbol")).toBe(false);
  const issuer = db
    .prepare(
      "SELECT id, bse_scrip_code, active, identity_verified_at FROM companies WHERE nse_symbol = 'OUTSIDE'",
    )
    .get();
  expect(issuer).toMatchObject({
    bse_scrip_code: "599999",
    active: 0,
    identity_verified_at: expect.any(String),
  });
  const selected = db
    .prepare(
      `SELECT f.company_id FROM processing_jobs j JOIN download_targets t ON t.id=j.entity_id
    JOIN source_filings f ON f.id=t.filing_id WHERE j.step='download'`,
    )
    .get();
  expect(selected.company_id).toBe(issuer.id);
  expect(
    db
      .prepare("SELECT count(*) FROM download_targets WHERE discarded=1")
      .pluck()
      .get(),
  ).toBe(3);
  const app = createApp({
    db,
    schemaVersion: 10,
    mode: cfg.DATA_MODE,
    ingestionStatus: service.status,
  });
  const { body } = await request(app).get("/api/watchlist").expect(200);
  expect(body.data).toHaveLength(8);
  expect(body.data.some(({ status }) => status === "skipped")).toBe(true);
  const details = await request(app)
    .get(`/api/companies/${issuer.id}`)
    .expect(200);
  expect(details.body.data.display_name).toBe("Outside Test Company");

  const calls = open.mock.calls.length;
  time += 299_000;
  expect(await scan()).toEqual([]);
  expect(open).toHaveBeenCalledTimes(calls);
  time += 1000;
  nse[1] = { ...nse[1], extra_provider_metadata: "changed" };
  expect(queued(await scan())).toBe(0);
  expect(status()).toMatchObject({ new_candidates: 0, selected_documents: 0 });
  expect(count("processing_jobs")).toBe(1);

  time += 300_000;
  nse[1] = {
    ...nse[1],
    desc: "Corrected conference call transcript",
    exchdisstime: "2026-10-26T10:07:00Z",
  };
  nse.push(nseTranscript("four", "fresh-transcript", "INFY", "10:08:00"));
  expect(queued(await scan())).toBe(1);
  expect(status()).toMatchObject({ new_candidates: 2, selected_documents: 1 });
  expect(count("processing_jobs")).toBe(2);

  const backfill = () =>
    service.watcher.tick({
      from: new Date("2026-10-26T09:55:00Z"),
      to: new Date(time),
      manual: true,
      force: true,
      company: "TCS",
    });
  nse[3] = {
    ...nse[3],
    extra_provider_metadata: "changed on discarded candidate",
  };
  expect(queued(await backfill())).toBe(0);
  expect(count("processing_jobs")).toBe(2);
  await service.once({
    from: new Date("2026-10-26T09:55:00Z"),
    to: new Date(time),
    manual: true,
    company: "TCS",
    processAi: false,
  });
  expect(
    db.prepare("SELECT company_id FROM transcripts").pluck().all(),
  ).toEqual([issuer.id]);
  expect(
    new Set(
      open.mock.calls
        .filter(([url]) => url.origin === origin)
        .map(([url]) => url.pathname),
    ),
  ).toEqual(new Set(["/shared-transcript.pdf"]));
});

it("resumes a partly committed live scan after restart without choosing a second document", async () => {
  verifiedCompany();
  db.prepare(
    "UPDATE companies SET identity_verified_at = ? WHERE nse_symbol = 'TCS'",
  ).run(prior);
  time = Date.parse("2026-10-26T10:00:00Z");
  const cfg = direct();
  const stop = new AbortController();
  const open = vi.fn(async (url) => {
    if (url.hostname === "nse.example.invalid")
      return response([nseTranscript("first", "first-transcript")]);
    await vi.waitFor(() => expect(count("processing_jobs")).toBe(1));
    stop.abort(new Error("Simulated shutdown"));
    return response({
      Table: [
        {
          ...bsePage1.Table[0],
          NEWSID: "next-bse",
          NEWS_DT: "2026-10-26T09:58:00Z",
          ATTACHMENT_URL: `${origin}/next-bse-transcript.pdf`,
        },
      ],
      Table1: [{ ROWCNT: 1 }],
    });
  });
  let service = ingress(cfg, open);
  await expect(
    service.watcher.tick({ automatic: true, signal: stop.signal }),
  ).rejects.toThrow("Simulated shutdown");
  expect(service.watcher.status()).toMatchObject({
    completed_at: null,
    new_candidates: 1,
    selected_documents: 1,
  });
  expect(count("processing_jobs")).toBe(1);

  db.close();
  db = openDatabase(cfg);
  time += 60_000;
  open.mockClear();
  service = ingress(cfg, open);
  expect(await service.watcher.tick({ automatic: true })).toMatchObject([
    { source: "NSE", result: "success", queued: 0 },
    { source: "BSE", result: "success", queued: 0 },
  ]);
  expect(open.mock.calls.map(([url]) => url.hostname)).toEqual([
    "bse.example.invalid",
  ]);
  expect(service.watcher.status()).toMatchObject({
    started_at: "2026-10-26T10:00:00.000Z",
    completed_at: "2026-10-26T10:01:00.000Z",
    new_candidates: 2,
    selected_documents: 1,
  });
  expect(count("processing_jobs")).toBe(1);
});

it("deduplicates NSE and BSE mirrors with different URLs and holds conflicting issuers for review", async () => {
  verifiedCompany();
  time = Date.parse("2026-10-26T10:00:00Z");
  const bseRows = [];
  const nse = nseTranscript("nse-original", "nse-original");
  const open = vi.fn((url) => {
    if (url.origin === origin)
      return response(
        makeFixturePdf(transcriptPages(), { wrapper: url.pathname }),
      );
    if (url.hostname === "nse.example.invalid") return response([nse]);
    const scrip = url.searchParams.get("strScrip");
    const rows = scrip
      ? bseRows.filter(({ SCRIP_CD }) => String(SCRIP_CD) === scrip)
      : bseRows;
    return response({ Table: rows, Table1: [{ ROWCNT: rows.length }] });
  });
  const cfg = direct();
  let service = ingress(cfg, open);
  async function selectAndProcess() {
    const scans = await service.watcher.tick({ automatic: true });
    expect(scans.reduce((sum, { queued }) => sum + queued, 0)).toBe(1);
    // Drain the selected job through the real download and PDF workers.
    await service.once({
      from: new Date(time - 1000),
      to: new Date(time),
      manual: true,
      company: "INFY",
      processAi: false,
    });
  }
  await selectAndProcess();
  db.close();
  db = openDatabase(cfg);
  service = ingress(cfg, open);

  time += 300_000;
  bseRows.push({
    ...bsePage1.Table[0],
    NEWSID: "bse-mirror",
    ATTACHMENT_URL: `${origin}/bse-mirror.pdf`,
    NEWS_DT: "2026-10-26T10:04:00Z",
  });
  await selectAndProcess();
  expect(count("documents")).toBe(2);
  expect(count("transcripts")).toBe(1);
  expect(count("concall_events")).toBe(1);
  const confirmedSources = db
    .prepare(
      `SELECT f.source FROM document_reviews r JOIN document_sources s ON s.id = r.source_id
    JOIN source_filings f ON f.id = s.filing_id WHERE r.transcript_id IS NOT NULL ORDER BY f.source`,
    )
    .pluck()
    .all();
  expect(confirmedSources).toEqual(["BSE", "NSE"]);

  time += 300_000;
  bseRows.push({
    ...bseRows[0],
    NEWSID: "wrong-issuer",
    SCRIP_CD: 532540,
    ATTACHMENT_URL: `${origin}/wrong-issuer.pdf`,
    NEWS_DT: "2026-10-26T10:09:00Z",
  });
  await selectAndProcess();
  expect(count("transcripts")).toBe(1);
  expect(count("concall_events")).toBe(1);
  expect(
    db
      .prepare(
        `SELECT r.classification, r.reason_code, r.transcript_id
    FROM document_reviews r JOIN document_sources s ON s.id = r.source_id
    JOIN source_filings f ON f.id = s.filing_id WHERE f.source_filing_id = 'wrong-issuer'`,
      )
      .get(),
  ).toEqual({
    classification: "needs_document",
    reason_code: "COMPANY_IDENTITY_CONFLICT",
    transcript_id: null,
  });
});

it("stores local fixture PDFs, validates hashes and stays idempotent across reboots", async () => {
  const open = vi.fn();
  const resolve = vi.fn();
  expect(await ingress(config(), open, resolve).once()).toMatchObject({
    polls: [{ queued: 2 }],
    downloads: { completed: 2 },
  });
  expect(count("documents")).toBe(2);
  expect(count("filing_documents")).toBe(2);
  for (const document of db.prepare("SELECT * FROM documents").all()) {
    const data = readFileSync(path.join(root, document.storage_relative_path));
    expect(sha256(data)).toBe(document.sha256);
    expect(data.length).toBe(document.size_bytes);
    expect(document.validation_status).toBe("validated");
  }
  db.close();
  db = openDatabase(config());
  expect(await ingress(config(), open, resolve).once()).toMatchObject({
    polls: [{ queued: 0 }],
    downloads: { completed: 2 },
  });
  expect(
    db
      .prepare(
        "SELECT DISTINCT source, classification FROM source_filings ORDER BY classification",
      )
      .all(),
  ).toEqual([
    { source: "FIXTURE", classification: "confirmed_transcript" },
    { source: "FIXTURE", classification: "needs_document" },
  ]);
  expect(count("transcripts")).toBe(1);
  expect(open).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it("prevents any upstream DNS or HTTP until a watchlist mapping has been verified", async () => {
  const open = vi.fn();
  const resolve = vi.fn();
  const service = ingress(
    direct({ BSE_ACCESS_AUTHORIZED: "false" }),
    open,
    resolve,
  );
  expect(await service.once()).toMatchObject({
    polls: [{ source: "NSE", code: "UNVERIFIED_COMPANY" }],
  });
  expect(service.status().sources.BSE).toMatchObject({
    status: "disabled",
    mode: "disabled_permission",
  });
  expect(service.status().sources.NSE).toMatchObject({
    status: "disabled",
    lastSuccessAt: null,
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("deduplicates a cross-exchange attachment and preserves a same-URL correction as a separate observation", async () => {
  verifiedCompany();
  let revised = false;
  const open = vi.fn((url) => {
    if (url.hostname === "nse.example.invalid") {
      return response(
        revised
          ? [
              {
                ...nseResponse[0],
                desc: "Corrected conference call transcript",
                an_dt: "27-Oct-2026 16:30:00",
              },
            ]
          : nseResponse,
      );
    }
    if (url.hostname === "bse.example.invalid")
      return response({ ...bsePage1, Table1: [{ ROWCNT: 1 }] });
    return response(pdfBytes(revised ? "cover-letter" : "transcript"));
  });
  const service = ingress(direct(), open);
  expect(await service.once()).toMatchObject({ downloads: { completed: 2 } });
  expect(open.mock.calls.filter(([url]) => url.origin === origin)).toHaveLength(
    1,
  );
  expect(count("source_filings")).toBe(3);
  expect(count("documents")).toBe(1);
  expect(count("filing_documents")).toBe(2);
  revised = true;
  time = new Date("2026-10-28T09:00:00Z").getTime();
  expect(await service.once()).toMatchObject({ downloads: { completed: 3 } });
  expect(count("documents")).toBe(2);
  expect(count("filing_observations")).toBe(4);
  expect(count("filing_documents")).toBe(3);
  expect(
    db
      .prepare(
        "SELECT reason_code FROM source_filings WHERE source_filing_id = ?",
      )
      .pluck()
      .get("SYN-NSE-001"),
  ).toBe("cover_letter_only");
  // Content review must retain the immutable correction observation even when the replacement is a notice.
  expect(
    db
      .prepare(
        `SELECT count(*) FROM filing_observations
    WHERE json_extract(normalized_json, '$.subject') = 'Corrected conference call transcript'`,
      )
      .pluck()
      .get(),
  ).toBe(1);
  expect(open.mock.calls.filter(([url]) => url.origin === origin)).toHaveLength(
    2,
  );
  expect(count("ai_runs")).toBe(0);
  expect(count("summaries")).toBe(0);
});

it("keeps the last successful cursor through interrupted BSE page two and resumes the missed window after restart", async () => {
  verifiedCompany();
  time = Date.parse(prior);
  const cfg = direct({ NSE_ACCESS_AUTHORIZED: "false" });
  const open = vi.fn(() => response({ Table: [], Table1: [{ ROWCNT: 0 }] }));
  let service = ingress(cfg, open);
  await service.once();
  const checkpoint = () =>
    db
      .prepare("SELECT last_successful_window_end FROM poll_cursors")
      .pluck()
      .get();
  expect(checkpoint()).toBe(prior);
  time = Date.parse(later);
  const controller = new AbortController();
  open.mockImplementation((url) => {
    if (url.searchParams.get("pageno") === "2") {
      controller.abort(new Error("simulated process interruption"));
      return response(bsePage2);
    }
    return response(bsePage1);
  });
  await expect(service.once({ signal: controller.signal })).rejects.toThrow(
    "simulated process interruption",
  );
  expect(count("source_filings")).toBe(0);
  expect(checkpoint()).toBe(prior);
  db.close();
  db = openDatabase(cfg);
  open.mockImplementation((url) =>
    url.origin === origin
      ? response(
          pdfBytes(
            url.pathname.includes("cover") ? "cover-letter" : "transcript",
          ),
        )
      : response(url.searchParams.get("pageno") === "1" ? bsePage1 : bsePage2),
  );
  service = ingress(cfg, open);
  expect(await service.once()).toMatchObject({
    polls: [{ queued: 2, result: "success" }],
    downloads: { completed: 2 },
  });
  expect(count("source_filings")).toBe(2);
  expect(checkpoint()).toBe(later);
  expect((await service.once()).polls[0].queued).toBe(0);
});

it("leaves a cursor unchanged on a malformed second page and persists an access hold across restart", async () => {
  verifiedCompany();
  const cfg = direct({ NSE_ACCESS_AUTHORIZED: "false" });
  const open = vi.fn((url) =>
    response(
      url.searchParams.get("pageno") === "1"
        ? bsePage1
        : { Table: [], Table1: [] },
    ),
  );
  let service = ingress(cfg, open);
  expect(await service.once()).toMatchObject({
    polls: [{ result: "incomplete" }],
  });
  expect(
    db
      .prepare("SELECT last_successful_window_end FROM poll_cursors")
      .pluck()
      .get(),
  ).toBeNull();
  expect(
    existsSync(path.join(root, "intermediate", "source-BSE-diagnostic.json")),
  ).toBe(true);
  expect(count("source_filings")).toBe(0);
  open.mockImplementation(() => response("forbidden", 403));
  expect(await service.once()).toMatchObject({
    polls: [{ result: "blocked" }],
  });
  const calls = open.mock.calls.length;
  db.close();
  db = openDatabase(cfg);
  service = ingress(cfg, open);
  expect(await service.once()).toMatchObject({
    polls: [{ result: "blocked" }],
  });
  expect(open).toHaveBeenCalledTimes(calls);
  expect(service.status().sources.BSE).toMatchObject({
    status: "blocked",
    lastSuccessAt: null,
  });
});

it("reclaims an expired job across connections and fences off the stale worker", async () => {
  const cfg = config();
  const service = ingress(cfg, vi.fn());
  await service.watcher.tick({
    from: new Date("2026-10-25"),
    to: new Date("2026-10-28"),
  });
  const process1 = createJobRepository(db, {
    leaseSeconds: 3,
    maxAttempts: 2,
    clock,
  });
  const abandoned = process1.claim();
  const other = openDatabase(cfg);
  try {
    const process2 = createJobRepository(other, {
      leaseSeconds: 3,
      maxAttempts: 2,
      clock,
    });
    const second = process2.claim();
    expect(second.id).not.toBe(abandoned.id);
    expect(process2.claim()).toBeNull();
    process2.fail(
      second,
      { code: "DOWNLOAD_INVALID_TYPE", message: "invalid" },
      null,
    );
    time += 4000;
    const recovered = process2.claim();
    expect(recovered).toMatchObject({
      id: abandoned.id,
      attempts: 2,
      last_error_code: "JOB_LEASE_LOST",
    });
    expect(recovered.lease_owner).not.toBe(abandoned.lease_owner);
    expect(() => process1.finish(abandoned, {})).toThrow(
      expect.objectContaining({ code: "JOB_LEASE_LOST" }),
    );
    process2.fail(
      recovered,
      { code: "DOWNLOAD_TIMEOUT", message: "timeout" },
      new Date(time + 1000),
    );
    expect(process2.counts()).toEqual({ dead: 2 });
  } finally {
    other.close();
  }
});

it("recovers a validated PDF checkpoint on the final transfer attempt without another request", async () => {
  verifiedCompany();
  const cfg = direct({ BSE_ACCESS_AUTHORIZED: "false", MAX_JOB_ATTEMPTS: "1" });
  const open = vi.fn((url) =>
    url.origin === origin
      ? response(pdfBytes("transcript"))
      : response(nseResponse),
  );
  let service = ingress(cfg, open);
  await service.watcher.tick();
  const job = service.jobs.claim();
  const artifact = await downloadDocument(
    service.sources.NSE,
    job.target.url,
    cfg,
  );
  service.jobs.recordArtifact(job, artifact);
  expect(count("filing_documents")).toBe(0);
  // Simulate loss of the worker after validation but before it linked the durable bytes.
  db.close();
  time += 4000;
  db = openDatabase(cfg);
  service = ingress(cfg, open);
  expect((await service.once()).downloads).toEqual({ completed: 1 });
  expect(count("filing_documents")).toBe(1);
  expect(open.mock.calls.filter(([url]) => url.origin === origin)).toHaveLength(
    1,
  );
});

it("uses the persisted overlap to discover a late publication older than the checkpoint", async () => {
  verifiedCompany();
  const cfg = direct({ BSE_ACCESS_AUTHORIZED: "false" });
  const open = vi.fn(() => response([]));
  const service = ingress(cfg, open);
  await service.once();
  time += 86_400_000;
  open.mockImplementation((url) =>
    url.origin === origin
      ? response(pdfBytes("transcript"))
      : response(nseResponse),
  );
  expect(await service.once()).toMatchObject({
    polls: [{ queued: 1 }],
    downloads: { completed: 1 },
  });
  expect(
    db
      .prepare("SELECT last_successful_window_end FROM poll_cursors")
      .pluck()
      .get(),
  ).toBe(new Date(time).toISOString());
  expect(
    db
      .prepare(
        "SELECT filing_published_at FROM source_filings WHERE source_filing_id = ?",
      )
      .pluck()
      .get("SYN-NSE-001"),
  ).toBe("2026-10-26T10:00:00.000Z");
});

it("persists retryable PDF failures across restart, then retries when due without rediscovering a duplicate job", async () => {
  verifiedCompany();
  const cfg = direct({ BSE_ACCESS_AUTHORIZED: "false" });
  const open = vi.fn((url) =>
    url.origin === origin
      ? response("temporary", 503, { "retry-after": "5" })
      : response(nseResponse),
  );
  expect((await ingress(cfg, open).once()).downloads).toEqual({
    retry_wait: 1,
  });
  expect(
    db.prepare("SELECT last_error_code FROM processing_jobs").pluck().get(),
  ).toBe("SOURCE_UNAVAILABLE");
  time += 5001;
  db.close();
  db = openDatabase(cfg);
  open.mockImplementation((url) =>
    url.origin === origin
      ? response(pdfBytes("transcript"))
      : response(nseResponse),
  );
  expect((await ingress(cfg, open).once()).downloads).toEqual({ completed: 1 });
  expect(count("documents")).toBe(1);
  expect(
    db
      .prepare("SELECT count(*) FROM processing_jobs WHERE step='download'")
      .pluck()
      .get(),
  ).toBe(1);
  expect(count("processing_jobs")).toBe(3);
});

it.each([
  [
    "HTML",
    () => response("<html>login</html>", 200, { "content-type": "text/html" }),
    "DOWNLOAD_INVALID_TYPE",
  ],
  [
    "wrong signature",
    () => response(Buffer.from("not a pdf")),
    "DOWNLOAD_INVALID_TYPE",
  ],
  [
    "corrupt PDF",
    () => response(Buffer.from("%PDF-1.4\ninvalid\n%%EOF")),
    "PDF_CORRUPT",
  ],
  [
    "oversized content-length",
    () => response(Buffer.from("%PDF-"), 200, { "content-length": "25000001" }),
    "DOWNLOAD_TOO_LARGE",
  ],
  [
    "partial PDF",
    () => {
      const stream = response(pdfBytes("transcript").subarray(0, 100), 200, {
        "content-length": "400",
      });
      stream.complete = false;
      return stream;
    },
    "SOURCE_UNAVAILABLE",
  ],
  [
    "unsafe redirect",
    () => response("", 302, { location: "https://169.254.169.254/private" }),
    "DOWNLOAD_UNSAFE_URL",
  ],
])(
  "rejects %s and cleans private temporary files",
  async (_label, open, code) => {
    const cfg = direct();
    const { NSE } = createSources(cfg, {
      network: { open: vi.fn(open), resolve: fakeAddresses },
    });
    await expect(
      downloadDocument(NSE, `${origin}/test.pdf`, cfg),
    ).rejects.toMatchObject({ code });
    expect(readdirSync(path.join(root, "documents"))).toEqual([]);
  },
);

it("limits actual streamed bytes and applies a deadline to the entire body", async () => {
  const cfg = direct({ MAX_DOWNLOAD_BYTES: "32", DOWNLOAD_TIMEOUT_MS: "25" });
  const large = createSources(cfg, {
    network: {
      resolve: fakeAddresses,
      open: () => response(pdfBytes("transcript")),
    },
  }).NSE;
  await expect(
    downloadDocument(large, `${origin}/large.pdf`, cfg),
  ).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
  const stall = createSources(cfg, {
    network: {
      resolve: fakeAddresses,
      open: (_url, { signal }) => {
        const stream = new Readable({ read() {} });
        stream.statusCode = 200;
        stream.headers = { "content-type": "application/pdf" };
        signal.addEventListener("abort", () => stream.destroy(signal.reason), {
          once: true,
        });
        return stream;
      },
    },
  }).NSE;
  await expect(
    downloadDocument(stall, `${origin}/stall.pdf`, cfg),
  ).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
  expect(readdirSync(path.join(root, "documents"))).toEqual([]);
});

it("keeps one scheduler owner and continuously drains the opt-in fixture watcher", async () => {
  const cfg = {
    ...config({ FIXTURE_WATCH_ENABLED: "true", POLL_INTERVAL_SECONDS: "1" }),
    PORT: 0,
  };
  const api = await startApi(cfg);
  try {
    await vi.waitFor(
      async () => {
        const result = await request(api.server).get("/api/status").expect(200);
        expect(result.body.data).toMatchObject({
          scheduler_running: true,
          data_mode: "fixture",
          download_jobs: { completed: 2 },
          ai_processing: {
            is_mock: true,
            jobs: expect.arrayContaining([
              expect.objectContaining({
                step: "verify_publish",
                status: "completed",
                count: 1,
              }),
            ]),
          },
          sources: {
            FIXTURE: { mode: "fixture" },
            NSE: { status: "disabled" },
          },
        });
      },
      { timeout: 8000, interval: 100 },
    );
    await expect(
      withPipelineLease(db, undefined, () => {}),
    ).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  } finally {
    await api.close();
  }
  expect(count("scheduler_leases")).toBe(0);
  expect(count("documents")).toBe(2);
}, 12_000);

it("waits out an abandoned scheduler lease on API restart and resumes automatically", async () => {
  const cfg = {
    ...config({ FIXTURE_WATCH_ENABLED: "true", POLL_INTERVAL_SECONDS: "1" }),
    PORT: 0,
  };
  db.prepare(
    "INSERT INTO scheduler_leases VALUES ('ingestion', 'abandoned', ?)",
  ).run(new Date(Date.now() + 1500).toISOString());
  const api = await startApi(cfg);
  try {
    const initial = await request(api.server).get("/api/status").expect(200);
    expect(initial.body.data.scheduler_running).toBe(false);
    await vi.waitFor(
      () => {
        expect(count("filing_documents")).toBe(2);
      },
      { timeout: 8000, interval: 100 },
    );
  } finally {
    await api.close();
  }
}, 12_000);

it("reacquires an expired scheduler lease and resumes polling without duplicate downloads", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const cfg = config({
    FIXTURE_WATCH_ENABLED: "true",
    POLL_INTERVAL_SECONDS: "1",
  });
  const service = ingress(cfg);
  const stop = new AbortController();
  const run = service.run(stop.signal);
  run.catch(() => {});
  const leaseOwner = () =>
    db
      .prepare("SELECT owner FROM scheduler_leases WHERE name = 'ingestion'")
      .pluck()
      .get();
  const source = () => service.status().sources.FIXTURE;
  try {
    await vi.waitFor(() => expect(source().lastSuccessAt).toBe(later), {
      timeout: 4000,
      interval: 50,
    });
    expect(service.status().scheduler_phase).toBe("running");
    const expiredOwner = leaseOwner();
    expect(expiredOwner).toBeTruthy();

    // Simulate the host waking after the 30-second lease has elapsed.
    time += 31_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(
      () => {
        expect(leaseOwner()).toBeTruthy();
        expect(leaseOwner()).not.toBe(expiredOwner);
        expect(service.status().scheduler_phase).toBe("running");
        expect(source().lastSuccessAt).toBe(new Date(time).toISOString());
      },
      { timeout: 6000, interval: 50 },
    );
    expect(count("download_targets")).toBe(2);
  } finally {
    stop.abort();
    vi.useRealTimers();
    await run;
  }
  expect(count("scheduler_leases")).toBe(0);
}, 12_000);
