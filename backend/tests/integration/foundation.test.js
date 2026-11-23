import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawMetadataSchema } from "@finosauras/shared";
import { createApp } from "../../src/app.js";
import { readConfig } from "../../src/config/env.js";
import { atomicWrite } from "../../src/utils/storage.js";
import { openDatabase } from "../../src/config/database.js";
import { migrateDatabase } from "../../src/models/migrate.js";
import { encodeJson, decodeJson } from "../../src/models/queries.js";
import { seedWatchlist } from "../../src/models/seed.js";
import { verifyWatchlist } from "../../src/models/verifyWatchlist.js";
import { startApi } from "../../src/index.js";

const now = "2026-11-22T18:30:00.000Z";
const clock = { now: () => new Date(now) };
const digest = "a".repeat(64);
let root;
let config;
let db;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "finosauras-db-"));
  config = readConfig({
    DATA_DIR: root,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
  });
  db = openDatabase(config);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (db.open) db.close();
  // Clean only the isolated temporary directory created for this test.
  rmSync(root, { recursive: true });
});

function bootstrap() {
  migrateDatabase(db, { clock });
  seedWatchlist(db, { clock });
  return db.prepare("SELECT id FROM companies WHERE nse_symbol = 'INFY'").get()
    .id;
}

function addFiling(company, source = "NSE", filing = "synthetic-1") {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO source_filings
    (id, company_id, source, source_filing_id, source_url, subject, description,
     raw_metadata_json, classification, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Synthetic test', '', ?, 'candidate', ?, ?)`,
  ).run(
    id,
    company,
    source,
    filing,
    "https://example.invalid/test",
    encodeJson(rawMetadataSchema, { synthetic: true }),
    now,
    now,
  );
  return id;
}

function addDocument(
  sha = digest,
  relativePath = "documents/aa/synthetic.pdf",
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO documents
    (id, sha256, storage_relative_path, mime_type, size_bytes, downloaded_at, validation_status, notes_json)
    VALUES (?, ?, ?, 'application/pdf', 1, ?, 'test', '[]')`,
  ).run(id, sha, relativePath, now);
  return id;
}

describe("persistent SQLite foundation", () => {
  it("records the reviewed watchlist identifiers once and preserves company history", () => {
    const companyId = bootstrap();
    const filingId = addFiling(companyId);
    const before = db
      .prepare("SELECT id, nse_symbol FROM companies ORDER BY nse_symbol")
      .all();
    const reviewed = verifyWatchlist(db);

    expect(reviewed).toMatchObject({ verified: 8, updated: 8 });
    const after = db
      .prepare(
        "SELECT id, nse_symbol, isin, identity_verified_at FROM companies ORDER BY nse_symbol",
      )
      .all();
    expect(after.map(({ id, nse_symbol }) => ({ id, nse_symbol }))).toEqual(
      before,
    );
    expect(
      after.every(
        ({ isin, identity_verified_at }) =>
          isin && identity_verified_at === reviewed.reviewed_at,
      ),
    ).toBe(true);
    expect(after.find(({ nse_symbol }) => nse_symbol === "DRREDDY").isin).toBe(
      "INE089A01031",
    );
    expect(
      db
        .prepare("SELECT company_id FROM source_filings WHERE id = ?")
        .get(filingId).company_id,
    ).toBe(companyId);
    expect(verifyWatchlist(db)).toEqual({ ...reviewed, updated: 0 });
  });

  it("rolls back the entire watchlist verification when a listed identifier conflicts", () => {
    bootstrap();
    db.prepare(
      "UPDATE companies SET bse_scrip_code = '999999' WHERE nse_symbol = 'LT'",
    ).run();
    expect(() => verifyWatchlist(db)).toThrow(
      expect.objectContaining({ code: "COMPANY_IDENTITY_CONFLICT" }),
    );
    expect(
      db
        .prepare(
          "SELECT count(*) FROM companies WHERE identity_verified_at IS NOT NULL",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("creates the complete schema once and preserves the same eight seed records across reopen", () => {
    expect(existsSync(config.DATABASE_PATH)).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(migrateDatabase(db, { clock })).toEqual({
      applied: 10,
      version: 10,
    });
    expect(seedWatchlist(db, { clock })).toEqual({ inserted: 8, total: 8 });
    const expectedNames = [
      "companies",
      "source_filings",
      "documents",
      "filing_documents",
      "transcripts",
      "concall_events",
      "event_transcripts",
      "processing_jobs",
      "summaries",
      "summary_evidence",
      "outbox_events",
      "poll_cursors",
      "source_health",
      "schema_migrations",
      "scheduler_leases",
      "filing_observations",
      "download_targets",
      "download_cache",
      "pdf_extractions",
      "document_sources",
      "document_reviews",
      "transcript_documents",
      "ai_runs",
      "ai_chunk_cache",
      "ai_provider_holds",
      "fixture_replays",
      "live_poll_cycles",
      "local_pdf_imports",
    ];
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .pluck()
      .all();
    expect(names.sort()).toEqual(expectedNames.sort());
    const companyRows = () =>
      db.prepare("SELECT * FROM companies ORDER BY nse_symbol").all();
    const original = companyRows();
    expect(
      original.every(
        (row) => row.identity_verified_at === null && row.created_at === now,
      ),
    ).toBe(true);
    db.close();
    db = openDatabase(config);
    expect(migrateDatabase(db, { clock })).toEqual({ applied: 0, version: 10 });
    expect(seedWatchlist(db, { clock })).toEqual({ inserted: 0, total: 8 });
    expect(companyRows()).toEqual(original);
    expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual([
      { version: 1, applied_at: now },
      { version: 2, applied_at: now },
      { version: 3, applied_at: now },
      { version: 4, applied_at: now },
      { version: 5, applied_at: now },
      { version: 6, applied_at: now },
      { version: 7, applied_at: now },
      { version: 8, applied_at: now },
      { version: 9, applied_at: now },
      { version: 10, applied_at: now },
    ]);
  });

  it("rolls back failed migration DDL before recording its version", () => {
    const directory = pathToFileURL(root + path.sep);
    writeFileSync(
      new URL("001_broken.sql", directory),
      "CREATE TABLE partial (id INTEGER); INVALID SQL;",
    );
    expect(() => migrateDatabase(db, { directory, clock })).toThrow(
      expect.objectContaining({ code: "DATABASE_MIGRATION_FAILED" }),
    );
    expect(
      db.prepare("SELECT count(*) AS count FROM schema_migrations").get().count,
    ).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'partial'").get(),
    ).toBeUndefined();
    expect(migrateDatabase(db, { clock })).toEqual({
      applied: 10,
      version: 10,
    });
  });

  it("enforces rollback, foreign keys, filing uniqueness and document uniqueness", () => {
    const company = bootstrap();
    expect(() => addFiling(randomUUID())).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
    );
    expect(() =>
      db.transaction(() => {
        addFiling(company);
        addFiling(company);
      })(),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }));
    expect(
      db.prepare("SELECT count(*) AS count FROM source_filings").get().count,
    ).toBe(0);
    const nse = addFiling(company);
    const bse = addFiling(company, "BSE");
    const document = addDocument();
    expect(() => addDocument(digest, "documents/duplicate.pdf")).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }),
    );
    expect(() => addDocument("b".repeat(64))).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" }),
    );
    const link = db.prepare(
      "INSERT INTO filing_documents VALUES (?, ?, 0, 'unknown')",
    );
    link.run(nse, document);
    link.run(bse, document);
    expect(() => link.run(nse, document)).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }),
    );
    const stored = db
      .prepare("SELECT raw_metadata_json FROM source_filings WHERE id = ?")
      .get(nse);
    expect(decodeJson(rawMetadataSchema, stored.raw_metadata_json)).toEqual({
      synthetic: true,
    });
    expect(() => decodeJson(rawMetadataSchema, "[]")).toThrow();
  });

  it("keeps two same-quarter calls separate and enforces evidence page bounds", () => {
    const company = bootstrap();
    const event = randomUUID();
    const transcript = randomUUID();
    const summary = randomUUID();
    const addEvent = db.prepare(`INSERT INTO concall_events
      (id, company_id, quarter, normalized_title, event_identity_key, created_at, updated_at)
      VALUES (?, ?, 'Q2 FY27', 'Synthetic call', ?, ?, ?)`);
    addEvent.run(event, company, "first-test-call", now, now);
    addEvent.run(randomUUID(), company, "second-test-call", now, now);
    db.prepare(
      `INSERT INTO transcripts
      (id, document_id, company_id, extraction_version, raw_text_path, clean_text_path, page_map_path,
       clean_text_sha256, page_count, character_count, extraction_quality_json, transcript_confidence,
       stage_status, created_at, updated_at)
      VALUES (?, ?, ?, 'test', 'raw.txt', 'clean.txt', 'map.json', ?, 2, 10, '{}', 'test', 'extracted', ?, ?)`,
    ).run(transcript, addDocument(), company, digest, now, now);
    db.prepare(
      "INSERT INTO event_transcripts VALUES (?, ?, 1, 'original', 1, ?)",
    ).run(event, transcript, now);
    db.prepare(
      `INSERT INTO summaries
      (id, event_id, transcript_id, prompt_version, model_id, ai_provider, is_mock, json_payload, markdown_payload,
       validation_status, validation_report_json, is_current, created_at)
      VALUES (?, ?, ?, 'test', 'test-model', 'mock', 1, '{}', '', 'pending', '{}', 0, ?)`,
    ).run(summary, event, transcript, now);
    const insert = db.prepare(`INSERT INTO summary_evidence
      (id, summary_id, claim_path, page_number, speaker, supporting_quote, supporting_quote_hash, verification_status, created_at)
      VALUES (?, ?, 'tldr[0]', ?, NULL, 'Synthetic quote', ?, 'test', ?)`);
    insert.run(randomUUID(), summary, 2, digest, now);
    expect(() => insert.run(randomUUID(), summary, 3, digest, now)).toThrow(
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" }),
    );
    expect(() =>
      db
        .prepare("UPDATE transcripts SET page_count = 1 WHERE id = ?")
        .run(transcript),
    ).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_TRIGGER" }));
    expect(
      db.prepare("SELECT count(*) AS count FROM concall_events").get().count,
    ).toBe(2);
  });

  it("replaces a file atomically and refuses a linked directory inside the storage root", async () => {
    const target = await atomicWrite(root, "extracted/synthetic.txt", "first");
    await atomicWrite(root, "extracted/synthetic.txt", "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(path.dirname(target))).toEqual(["synthetic.txt"]);
    // A junction on Windows needs no developer-mode symlink permission.
    symlinkSync(
      path.join(root, "extracted"),
      path.join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      atomicWrite(root, "alias/synthetic.txt", "must not overwrite"),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(readFileSync(target, "utf8")).toBe("second");
  });
});

describe("HTTP health", () => {
  it("keeps liveness healthy while an unmigrated or closed SQLite connection is unready", async () => {
    const app = createApp({ db, schemaVersion: 10, mode: "fixture", clock });
    await request(app)
      .get("/api/health/ready")
      .expect(503, {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Database is unavailable",
        },
      });
    await request(app)
      .get("/api/health/live")
      .expect(200, {
        data: { status: "ok" },
        meta: { mode: "fixture", generated_at: now },
      });
    bootstrap();
    const ready = await request(app).get("/api/health/ready").expect(200);
    expect(ready.body.data.status).toBe("ready");
    expect(ready.headers).not.toHaveProperty("x-powered-by");
    await request(app).post("/api/health/ready").expect(404);
    db.close();
    await request(app).get("/api/health/ready").expect(503);
    await request(app).get("/api/health/live").expect(200);
  });

  it("boots and gracefully closes in fixture mode without calling fetch or populating filings", async () => {
    const upstreamFetch = vi.fn(() => {
      throw new Error("Unexpected outbound request");
    });
    vi.stubGlobal("fetch", upstreamFetch);
    const { server, close } = await startApi({
      ...config,
      PORT: 0,
      FIXTURE_WATCH_ENABLED: false,
    });
    try {
      const response = await request(server)
        .get("/api/health/ready")
        .expect(200);
      expect(response.body.meta.mode).toBe("fixture");
      expect(upstreamFetch).not.toHaveBeenCalled();
      expect(
        db.prepare("SELECT count(*) AS count FROM source_filings").get().count,
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) AS count FROM summaries").get().count,
      ).toBe(0);
    } finally {
      await close();
    }
    expect(server.listening).toBe(false);
  });
});
