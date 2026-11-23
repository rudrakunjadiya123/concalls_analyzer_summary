import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { normalizedFilingSchema } from "@finosauras/shared";
import { readConfig } from "../../src/config/env.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { seedWatchlist } from "../../src/db/seed.js";
import { atomicWrite } from "../../src/core/storage.js";
import { sha256, documentStorageKey } from "../../src/core/hash.js";
import { createIngestionService } from "../../src/ingestion/service.js";
import {
  backfillDocumentSources,
  createPdfRepository,
  registerDocumentSource,
} from "../../src/jobs/pdfRepository.js";
import {
  loadExtraction,
  materializeExtraction,
} from "../../src/pdf/artifacts.js";
import { inspectTranscript } from "../../src/cli/inspectTranscript.js";
import {
  makeFixturePdf,
  transcriptPages,
} from "../../scripts/stage3-pdf-fixtures.js";

const firstPublication = "2026-10-27T09:00:00.000Z";
const secondPublication = "2026-10-29T09:00:00.000Z";
const now = "2026-11-02T09:00:00.000Z";
const pdf = (name) =>
  readFileSync(
    new URL(`../../fixtures/pdf/stage3/${name}.pdf`, import.meta.url),
  );
let root, config, db, time;
const clock = { now: () => new Date(time) };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "finosauras-pdf-"));
  time = Date.parse(now);
  config = readConfig({
    DATA_DIR: root,
    WORKER_LEASE_SECONDS: "1",
    MAX_JOB_ATTEMPTS: "1",
    LOG_LEVEL: "silent",
  });
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

/** Stage a fictional attachment using the exact storage key and immutable observation used by the queue. */
async function attach(
  bytes,
  {
    filingId = randomUUID(),
    subject = "Synthetic earnings call transcript",
    publishedAt = firstPublication,
    pending = true,
    callDateHint = null,
    quarterHint = null,
  } = {},
) {
  const company = db
    .prepare("SELECT * FROM companies WHERE nse_symbol = 'INFY'")
    .get();
  const hash = sha256(bytes);
  const key = documentStorageKey(hash);
  await atomicWrite(root, key, bytes);
  db.prepare(
    `INSERT INTO documents
    (id,sha256,storage_relative_path,mime_type,size_bytes,downloaded_at,validation_status,notes_json)
    VALUES (?,?,?,'application/pdf',?,?,'validated','[]') ON CONFLICT(sha256) DO NOTHING`,
  ).run(randomUUID(), hash, key, bytes.length, now);
  const doc = db.prepare("SELECT * FROM documents WHERE sha256 = ?").get(hash);
  const normalized = normalizedFilingSchema.parse({
    source: "FIXTURE",
    sourceFilingId: filingId,
    subject,
    description: "",
    category: null,
    subcategory: null,
    company: {
      displayName: "Synthetic Test Company",
      nseSymbol: company.nse_symbol,
      bseScripCode: null,
      isin: null,
    },
    publishedAt,
    callDateHint,
    quarterHint,
    sourceUrl: "https://example.invalid/fixture",
    attachments: [],
    raw: { synthetic: true },
  });
  const fingerprint = sha256(JSON.stringify(normalized));
  db.prepare(
    `INSERT INTO source_filings
    (id,company_id,source,source_filing_id,subject,description,source_url,filing_published_at,raw_metadata_json,
      classification,created_at,updated_at,ingestion_fingerprint)
    VALUES (?,?,'FIXTURE',?,?,'',?,?,'{"synthetic":true}','candidate',?,?,?)
    ON CONFLICT(id) DO UPDATE SET subject=excluded.subject,filing_published_at=excluded.filing_published_at,
      ingestion_fingerprint=excluded.ingestion_fingerprint,classification='candidate'`,
  ).run(
    filingId,
    company.id,
    filingId,
    subject,
    normalized.sourceUrl,
    publishedAt,
    now,
    now,
    fingerprint,
  );
  db.prepare(
    "INSERT INTO filing_observations VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
  ).run(filingId, fingerprint, JSON.stringify(normalized), now);
  db.prepare(
    "INSERT INTO filing_documents VALUES (?,?,0,'unknown') ON CONFLICT DO NOTHING",
  ).run(filingId, doc.id);
  if (pending) registerDocumentSource(db, doc.id, filingId, fingerprint, now);
  return { doc, filingId };
}

const run = () =>
  createIngestionService(db, config, { clock }).once({ processAi: false });

it("deduplicates whitespace-equivalent PDF wrappers and keeps another call in the same quarter separate", async () => {
  const original = await attach(pdf("single-column"));
  const duplicate = await attach(
    makeFixturePdf(transcriptPages(), { wrapper: "different bytes" }),
  );
  const other = await attach(
    makeFixturePdf(
      transcriptPages({
        title: "Synthetic Industrial Earnings Conference Call Q2 FY27",
        date: "Call held on 26 October 2026",
        figure: "₹850.00 crore",
      }),
    ),
  );
  await run();
  const originalReview = inspectTranscript(db, original.doc.id).reviews[0];
  const duplicateReview = inspectTranscript(db, duplicate.doc.id).reviews[0];
  const otherReview = inspectTranscript(db, other.doc.id).reviews[0];
  expect(originalReview).toMatchObject({
    quarter: "Q2 FY27",
    call_date: "2026-10-26",
    period_end: "2026-09-30",
  });
  expect(duplicateReview.transcript_id).toBe(originalReview.transcript_id);
  expect(duplicateReview.event_id).toBe(originalReview.event_id);
  expect(otherReview.event_id).not.toBe(originalReview.event_id);
  expect(
    db
      .prepare(
        "SELECT count(*) FROM transcript_documents WHERE relation='duplicate_text'",
      )
      .pluck()
      .get(),
  ).toBe(1);
  const saved = await loadExtraction(original.doc, config);
  expect(saved.manifest.pages[0].cleaned_text).toContain("₹1,200.00 crore");
  expect(readFileSync(path.join(root, saved.paths.clean), "utf8")).toContain(
    "[Page 2]",
  );
  expect(JSON.stringify(inspectTranscript(db, original.doc.id))).not.toContain(
    "Could you explain",
  );
});

it("retains original evidence when a newer corrected filing supplies a new version", async () => {
  const { doc: original, filingId } = await attach(pdf("single-column"));
  await run();
  const old = inspectTranscript(db, original.id).reviews[0];
  const priorText = await loadExtraction(original, config);
  const priorBytes = readFileSync(path.join(root, priorText.paths.clean));
  const replacement = await attach(
    makeFixturePdf(transcriptPages({ figure: "₹1,280.00 crore" })),
    {
      filingId,
      subject: "Corrected earnings conference call transcript",
      publishedAt: secondPublication,
    },
  );
  await run();
  const fresh = inspectTranscript(db, replacement.doc.id).reviews[0];
  expect(fresh).toMatchObject({
    event_id: old.event_id,
    version_number: 2,
    revision_kind: "correction",
    decision: "revision_pending",
    is_current: 0,
  });
  expect(
    db
      .prepare("SELECT current_transcript_id FROM concall_events WHERE id=?")
      .pluck()
      .get(old.event_id),
  ).toBe(old.transcript_id);
  expect(readFileSync(path.join(root, priorText.paths.clean))).toEqual(
    priorBytes,
  );
  expect(
    (await loadExtraction(replacement.doc, config)).manifest.pages[0]
      .cleaned_text,
  ).toContain("₹1,280.00 crore");
  expect(
    db
      .prepare("SELECT count(*) FROM filing_documents WHERE filing_id=?")
      .pluck()
      .get(filingId),
  ).toBe(2);
  expect(count("summaries")).toBe(0);
  expect(count("outbox_events")).toBe(0);
});

it("keeps ambiguous different text separate when title and date match without a correction", async () => {
  const original = await attach(pdf("single-column"));
  await run();
  const second = await attach(
    makeFixturePdf(transcriptPages({ figure: "₹1,199.00 crore" })),
    { publishedAt: secondPublication },
  );
  await run();
  const before = inspectTranscript(db, original.doc.id).reviews[0];
  const after = inspectTranscript(db, second.doc.id).reviews[0];
  expect(after).toMatchObject({
    decision: "ambiguous_revision",
    is_current: 0,
  });
  expect(after.event_id).not.toBe(before.event_id);
  expect(after.warnings).toContain("event_identity_uncertain");
  expect(
    db
      .prepare("SELECT stage_status FROM transcripts WHERE id=?")
      .pluck()
      .get(after.transcript_id),
  ).toBe("needs_review");
});

it("records scanned, corrupt, and blank attachments without blocking a confirmed candidate", async () => {
  const scanned = await attach(pdf("scanned-image"));
  const empty = await attach(pdf("empty"));
  const corrupt = await attach(pdf("corrupt"));
  const confirmed = await attach(pdf("single-column"));
  await run();
  expect(inspectTranscript(db, scanned.doc.id)).toMatchObject({
    status: "extracted",
    quality: { suspected_scanned: true },
    reviews: [{ classification: "needs_document", reason_code: "ocr_needed" }],
  });
  expect(inspectTranscript(db, empty.doc.id).reviews[0]).toMatchObject({
    reason_code: "PDF_TEXT_UNAVAILABLE",
  });
  expect(inspectTranscript(db, corrupt.doc.id)).toMatchObject({
    status: "failed",
    error_code: "PDF_CORRUPT",
    reviews: [{ classification: "needs_document" }],
  });
  expect(inspectTranscript(db, confirmed.doc.id).reviews[0]).toMatchObject({
    classification: "confirmed_transcript",
  });
  expect(
    db
      .prepare(
        "SELECT count(*) FROM processing_jobs WHERE step='extract' AND status='dead'",
      )
      .pluck()
      .get(),
  ).toBe(1);
});

it("reuses a completed private artifact after the extractor dies before its SQLite checkpoint", async () => {
  const { doc } = await attach(pdf("single-column"));
  const repo = createPdfRepository(db, {
    clock,
    leaseSeconds: 1,
    maxAttempts: 1,
  });
  const abandoned = repo.claim();
  const saved = await materializeExtraction(doc, config);
  const timestamp = statSync(path.join(root, saved.paths.pages)).mtimeMs;
  expect(abandoned).toMatchObject({ entity_id: doc.id, step: "extract" });
  // Move only the generated test PDF. A successful retry must use the validated artifact.
  renameSync(
    path.join(root, doc.storage_relative_path),
    path.join(root, "test-original.pdf"),
  );
  db.close();
  time += 1500;
  db = openDatabase(config);
  await run();
  expect(inspectTranscript(db, doc.id).reviews[0]).toMatchObject({
    classification: "confirmed_transcript",
  });
  const recovered = db
    .prepare("SELECT status,attempts FROM processing_jobs WHERE id=?")
    .get(abandoned.id);
  expect(recovered).toEqual({ status: "completed", attempts: 2 });
  expect(statSync(path.join(root, saved.paths.pages)).mtimeMs).toBe(timestamp);
});

it("queues an older downloaded attachment and rejects a manifest whose private text was changed", async () => {
  const { doc } = await attach(pdf("single-column"), { pending: false });
  expect(count("document_sources")).toBe(0);
  backfillDocumentSources(db, now);
  expect(count("document_sources")).toBe(1);
  await run();
  const saved = await loadExtraction(doc, config);
  await atomicWrite(root, saved.paths.clean, "tampered generated text");
  expect(await loadExtraction(doc, config)).toBeNull();
  expect(
    (await materializeExtraction(doc, config)).manifest.clean_text_sha256,
  ).toBe(saved.manifest.clean_text_sha256);
});
