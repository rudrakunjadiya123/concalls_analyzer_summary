import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { summaryEventSchema } from "@finosauras/shared";
import { readConfig } from "../../src/config/env.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { seedWatchlist } from "../../src/db/seed.js";
import { createIngestionService } from "../../src/ingestion/service.js";
import { createMockProvider } from "../../src/ai/mock.js";
import { verifyStoredSummary } from "../../src/cli/verifySummary.js";
import { PipelineError } from "../../src/core/errors.js";
import { atomicWrite } from "../../src/core/storage.js";
import { documentStorageKey, sha256 } from "../../src/core/hash.js";
import { registerDocumentSource } from "../../src/jobs/pdfRepository.js";
import { makeFixturePdf } from "../../scripts/stage3-pdf-fixtures.js";

let root, db, config, time;
const clock = { now: () => new Date(time) };
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "finosauras-ai-"));
  time = Date.parse("2026-11-02T10:00:00Z");
  config = readConfig({ DATA_DIR: root, LOG_LEVEL: "silent" });
  db = openDatabase(config);
  migrateDatabase(db, { clock });
  seedWatchlist(db, { clock });
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true });
});

const count = (table) =>
  db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
const events = () =>
  db
    .prepare("SELECT payload_json FROM outbox_events ORDER BY id")
    .pluck()
    .all()
    .map((json) => summaryEventSchema.parse(JSON.parse(json)));
const run = (aiProvider = createMockProvider()) =>
  createIngestionService(db, config, { clock, aiProvider }).once();

/** Add a synthetic corrected PDF to the existing immutable filing and document lineage. */
async function correctedDocument() {
  const filing = db
    .prepare(
      "SELECT * FROM source_filings WHERE source_filing_id='synthetic-stage4-call'",
    )
    .get();
  const original = db
    .prepare(
      "SELECT normalized_json FROM filing_observations WHERE filing_id=?",
    )
    .pluck()
    .get(filing.id);
  const bytes = makeFixturePdf(
    [
      [
        [40, 745, "SYNTHETIC TEST DATA - NO REAL FINANCIAL RESULTS"],
        [40, 715, "Synthetic Test Company Earnings Conference Call Q2 FY27"],
        [40, 680, "Call held on 26 October 2026"],
        [40, 650, "Moderator: Welcome to this fictional earnings call."],
        [
          40,
          620,
          "Management: Consolidated revenue was ₹1,250 crore in Q2 FY27.",
        ],
        [40, 596, "Management: Standalone revenue was ₹850 crore in Q2 FY27."],
        [40, 574, "Management: We expect revenue growth of 9–11% next year."],
        [
          40,
          548,
          "Management: Supply disruption remains a risk for the industrial division.",
        ],
      ],
    ],
    { wrapper: "synthetic correction" },
  );
  const sha = sha256(bytes);
  const key = documentStorageKey(sha);
  await atomicWrite(root, key, bytes);
  const publishedAt = "2026-11-01T09:00:00.000Z";
  const next = {
    ...JSON.parse(original),
    subject: "Corrected synthetic earnings conference call transcript",
    publishedAt,
  };
  const fingerprint = sha256(JSON.stringify(next));
  const id = randomUUID();
  const instant = clock.now().toISOString();
  db.prepare(
    `INSERT INTO documents
    (id,sha256,storage_relative_path,mime_type,size_bytes,downloaded_at,validation_status,notes_json)
    VALUES (?,?,?,'application/pdf',?,?,'validated','[]')`,
  ).run(id, sha, key, bytes.length, instant);
  db.prepare("INSERT INTO filing_observations VALUES (?,?,?,?)").run(
    filing.id,
    fingerprint,
    JSON.stringify(next),
    instant,
  );
  db.prepare(
    "UPDATE source_filings SET subject=?,filing_published_at=?,ingestion_fingerprint=?,classification='candidate' WHERE id=?",
  ).run(next.subject, publishedAt, fingerprint, filing.id);
  db.prepare("INSERT INTO filing_documents VALUES (?,?,0,'unknown')").run(
    filing.id,
    id,
  );
  registerDocumentSource(db, id, filing.id, fingerprint, instant);
  return id;
}

it("automatically publishes one labeled mock JSON/Markdown summary with evidence and a durable event", async () => {
  const fake = createMockProvider();
  const map = vi.spyOn(fake, "generateFacts");
  const synthesize = vi.spyOn(fake, "synthesize");
  await run(fake);
  expect(count("summaries")).toBe(1);
  expect(count("summary_evidence")).toBeGreaterThan(20);
  expect(count("outbox_events")).toBe(1);
  const [event] = events();
  expect(event).toMatchObject({
    type: "summary.created",
    event_id: 1,
    data_mode: "fixture",
    data: {
      is_mock: true,
      revision: 1,
      summary: { company: "Synthetic Test Company", nse_symbol: null },
    },
  });
  const inspection = await verifyStoredSummary(
    db,
    config,
    event.data.summary_id,
    { show: true },
  );
  expect(inspection).toMatchObject({
    status: "verified",
    provider: "mock",
    model: "synthetic-extractive-v1",
  });
  expect(inspection.markdown).toContain("Synthetic fixture · mock output");
  expect(inspection.markdown).toContain("₹1,200 crore");
  expect(map).toHaveBeenCalledOnce();
  expect(synthesize).toHaveBeenCalledOnce();
  await run(fake);
  expect(map).toHaveBeenCalledOnce();
  expect(synthesize).toHaveBeenCalledOnce();
  expect(events()).toEqual([event]);
  db.prepare(
    "UPDATE summaries SET markdown_payload='tampered synthetic markdown' WHERE id=?",
  ).run(event.data.summary_id);
  await expect(
    verifyStoredSummary(db, config, event.data.summary_id),
  ).rejects.toMatchObject({ code: "AI_EVIDENCE_UNSUPPORTED" });
});

it("publishes a verified correction as one ordered summary.updated event and retains old history", async () => {
  await run();
  const [prior] = events();
  const original = db
    .prepare("SELECT * FROM summaries WHERE id=?")
    .get(prior.data.summary_id);
  await correctedDocument();
  await run();
  const [first, next] = events();
  expect(first).toEqual(prior);
  expect(next).toMatchObject({
    event_id: 2,
    type: "summary.updated",
    data: {
      revision: 2,
      concall_event_id: prior.data.concall_event_id,
      is_mock: true,
    },
  });
  expect(
    next.data.summary.key_metrics.some(({ value }) => value === "₹1,250 crore"),
  ).toBe(true);
  const old = db
    .prepare("SELECT * FROM summaries WHERE id=?")
    .get(prior.data.summary_id);
  expect(old).toEqual({ ...original, is_current: 0 });
  expect(
    db.prepare("SELECT id FROM summaries WHERE is_current=1").pluck().all(),
  ).toEqual([next.data.summary_id]);
  expect(
    db
      .prepare("SELECT current_transcript_id FROM concall_events WHERE id=?")
      .pluck()
      .get(next.data.concall_event_id),
  ).not.toBe(original.transcript_id);
  expect(
    await verifyStoredSummary(db, config, first.data.summary_id),
  ).toMatchObject({ status: "verified", revision: 1 });
  expect(
    await verifyStoredSummary(db, config, next.data.summary_id),
  ).toMatchObject({ status: "verified", revision: 2 });
});

it("rolls back summary, evidence, pointer and outbox together, then publishes the persisted draft once", async () => {
  const fake = createMockProvider();
  const map = vi.spyOn(fake, "generateFacts");
  await run(fake);
  const [prior] = events();
  const pointer = db
    .prepare("SELECT current_transcript_id FROM concall_events WHERE id=?")
    .pluck()
    .get(prior.data.concall_event_id);
  await correctedDocument();
  const originalEvidence = count("summary_evidence");
  // Fail the final write, after the summary, evidence and current-version pointers have been changed.
  db.exec(`CREATE TEMP TRIGGER synthetic_outbox_failure BEFORE UPDATE ON outbox_events
    BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`);
  await run(fake);
  expect(count("summaries")).toBe(1);
  expect(count("summary_evidence")).toBe(originalEvidence);
  expect(count("outbox_events")).toBe(1);
  expect(
    db
      .prepare("SELECT current_transcript_id FROM concall_events WHERE id=?")
      .pluck()
      .get(prior.data.concall_event_id),
  ).toBe(pointer);
  expect(
    db
      .prepare(
        "SELECT count(*) FROM processing_jobs WHERE step='verify_publish' AND status='retry_wait'",
      )
      .pluck()
      .get(),
  ).toBe(1);
  db.exec("DROP TRIGGER synthetic_outbox_failure");
  time += 60_000;
  await run(fake);
  expect(count("summaries")).toBe(2);
  expect(count("outbox_events")).toBe(2);
  expect(map).toHaveBeenCalledTimes(2);
});

it("honors provider Retry-After across restarts and reuses chunk facts instead of calling MAP twice", async () => {
  const fake = createMockProvider();
  const map = vi.spyOn(fake, "generateFacts");
  const original = fake.synthesize;
  let fail = true;
  fake.synthesize = vi.fn(async (args) => {
    if (fail) {
      fail = false;
      const error = new PipelineError("AI_RATE_LIMITED", undefined, {
        retryable: true,
      });
      error.retryAfter = "60";
      throw error;
    }
    return original(args);
  });
  await run(fake);
  expect(count("summaries")).toBe(0);
  expect(count("ai_chunk_cache")).toBe(1);
  expect(count("ai_provider_holds")).toBe(1);
  db.close();
  db = openDatabase(config);
  time += 59_000;
  await run(fake);
  expect(fake.synthesize).toHaveBeenCalledOnce();
  time += 2000;
  await run(fake);
  expect(map).toHaveBeenCalledOnce();
  expect(fake.synthesize).toHaveBeenCalledTimes(2);
  expect(count("summaries")).toBe(1);
  expect(count("outbox_events")).toBe(1);
});

it("allows one bounded format repair, then withholds invalid JSON and publishes no event", async () => {
  const fake = createMockProvider();
  fake.generateFacts = vi.fn(async () => ({ invalid: ["malformed"] }));
  await run(fake);
  await run(fake);
  expect(fake.generateFacts).toHaveBeenCalledTimes(2);
  expect(fake.generateFacts.mock.calls[1][0].repair).toBe(true);
  expect(count("summaries")).toBe(0);
  expect(count("outbox_events")).toBe(0);
  expect(
    db
      .prepare(
        "SELECT status,last_error_code FROM processing_jobs WHERE step='summarize'",
      )
      .get(),
  ).toEqual({
    status: "dead",
    last_error_code: "AI_SCHEMA_INVALID",
  });
});

it("uses one targeted re-selection for an unsupported synthesis reference", async () => {
  const fake = createMockProvider();
  const original = fake.synthesize;
  fake.synthesize = vi.fn(async (input) => {
    const selection = await original(input);
    return input.targeted
      ? selection
      : { ...selection, tldr: ["fake-reference", ...selection.tldr.slice(1)] };
  });
  await run(fake);
  expect(fake.synthesize).toHaveBeenCalledTimes(2);
  expect(fake.synthesize.mock.calls[1][0].targeted).toBe(true);
  expect(count("summaries")).toBe(1);
  expect(count("outbox_events")).toBe(1);
});

it("does not let an older verified draft become current after a correction arrives", async () => {
  db.exec(`CREATE TEMP TRIGGER synthetic_outbox_failure BEFORE UPDATE ON outbox_events
    BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`);
  await run();
  expect(count("summaries")).toBe(0);
  db.exec("DROP TRIGGER synthetic_outbox_failure");
  time += 60_000;
  await correctedDocument();
  await run();
  const [only] = events();
  expect(only).toMatchObject({
    type: "summary.created",
    data: { revision: 2 },
  });
  expect(count("summaries")).toBe(1);
  expect(
    db
      .prepare(
        "SELECT last_error_code FROM processing_jobs WHERE step='verify_publish' AND status='dead'",
      )
      .pluck()
      .all(),
  ).toEqual(["AI_STALE_REVISION"]);
});
