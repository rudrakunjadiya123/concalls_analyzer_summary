import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SOURCES } from "@finosauras/shared/constants";
import { PipelineError } from "../../utils/errors.js";
import { systemClock, utcIso } from "../../utils/clock.js";
import { encodeJson } from "../queries.js";
import { registerDocumentSource } from "./pdfRepository.js";

/** Lease and finalize download jobs transactionally against an immutable download target. */
export function createJobRepository(
  db,
  { leaseSeconds, maxAttempts, clock = systemClock },
) {
  const target = db.prepare(`SELECT t.*, f.source FROM download_targets t
    JOIN source_filings f ON f.id = t.filing_id WHERE t.id = ?`);
  const cache = db.prepare(
    `SELECT d.* FROM download_cache c JOIN documents d ON d.id = c.document_id WHERE c.cache_key = ?`,
  );
  const guard =
    db.prepare(`SELECT 1 FROM processing_jobs WHERE id = ? AND step = 'download' AND status = 'running'
    AND lease_owner = ? AND lease_expires_at > ?`);
  const update =
    db.prepare(`UPDATE processing_jobs SET status = @status, updated_at = @now, next_run_at = @next,
    lease_owner = NULL, lease_expires_at = NULL, last_error_code = @code, last_error_message = @message,
    attempts = attempts - @release WHERE id = @id AND lease_owner = @owner`);
  const owned = (job, now) => {
    if (!guard.get(job.id, job.lease_owner, now))
      throw new PipelineError("JOB_LEASE_LOST");
  };
  const finalize = (job, status, now, next = now, error = {}, release = 0) =>
    update.run({
      id: job.id,
      owner: job.lease_owner,
      status,
      now,
      next,
      code: error.code ?? null,
      message: error.message ?? null,
      release,
    });
  const nowPlus = (now) =>
    utcIso(new Date(now.getTime() + leaseSeconds * 1000));
  const recover = db.prepare(`UPDATE processing_jobs SET status = CASE
    WHEN attempts > @attempts OR (attempts = @attempts AND NOT EXISTS (
      SELECT 1 FROM download_targets t JOIN download_cache c ON c.cache_key = t.cache_key
      WHERE t.id = processing_jobs.entity_id
    )) THEN 'dead' ELSE 'retry_wait' END,
    lease_owner = NULL, lease_expires_at = NULL, next_run_at = @now, updated_at = @now,
    last_error_code = 'JOB_LEASE_LOST', last_error_message = 'Expired download lease recovered'
    WHERE step = 'download' AND status = 'running' AND lease_expires_at <= @now`);
  const claimNext = db.prepare(`UPDATE processing_jobs
    SET status = 'running', attempts = attempts + 1, lease_owner = @owner, lease_expires_at = @expires, updated_at = @now
    WHERE id = (SELECT j.id FROM processing_jobs j
      JOIN download_targets t ON t.id = j.entity_id JOIN source_filings f ON f.id = t.filing_id
      WHERE j.step = 'download' AND t.discarded = 0 AND j.next_run_at <= @now AND f.source IN (SELECT value FROM json_each(@sources))
      AND (@targetId IS NULL OR t.id = @targetId)
      AND j.status IN ('queued', 'retry_wait') AND (j.attempts < @attempts OR (
        j.attempts = @attempts AND EXISTS (SELECT 1 FROM download_cache c WHERE c.cache_key = t.cache_key)
      )) ORDER BY j.next_run_at, j.id LIMIT 1)
    RETURNING *`);

  return {
    claim: db.transaction((sources = SOURCES, targetId = null) => {
      const instant = clock.now();
      const now = utcIso(instant);
      recover.run({ now, attempts: maxAttempts });
      const job = claimNext.get({
        now,
        attempts: maxAttempts,
        owner: randomUUID(),
        expires: nowPlus(instant),
        sources: JSON.stringify(sources),
        targetId,
      });
      return job ? { ...job, target: target.get(job.entity_id) } : null;
    }).immediate,
    cached: (key) => cache.get(key),
    renew(job) {
      const instant = clock.now();
      return Boolean(
        db
          .prepare(
            `UPDATE processing_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
          )
          .run(
            nowPlus(instant),
            utcIso(instant),
            job.id,
            job.lease_owner,
            utcIso(instant),
          ).changes,
      );
    },
    recordArtifact: db.transaction((job, artifact) => {
      const now = utcIso(clock.now());
      owned(job, now);
      const { cache_key: key, filename } = job.target;
      // Checkpoint the validated artifact before creating a filing link so recovery can skip transfer.
      const fields = [
        randomUUID(),
        artifact.sha256,
        artifact.storageRelativePath,
        filename,
        artifact.sizeBytes,
        now,
        encodeJson(z.array(z.string()), ["pdf_container_validated"]),
      ];
      db.prepare(
        `INSERT INTO documents
          (id, sha256, storage_relative_path, mime_type, original_name, size_bytes, downloaded_at, validation_status, notes_json)
          VALUES (?, ?, ?, 'application/pdf', ?, ?, ?, 'validated', ?)
          ON CONFLICT(sha256) DO NOTHING`,
      ).run(...fields);
      const documentId = db
        .prepare("SELECT id FROM documents WHERE sha256 = ?")
        .get(artifact.sha256).id;
      db.prepare(
        `INSERT INTO download_cache VALUES (?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET document_id = excluded.document_id`,
      ).run(key, documentId);
      return documentId;
    }).immediate,
    finish: db.transaction((job, artifact) => {
      const now = utcIso(clock.now());
      owned(job, now);
      const { filing_id: filingId, attachment_index: index } = job.target;
      const { documentId } = artifact;
      db.prepare(
        `INSERT INTO filing_documents VALUES (?, ?, ?, 'unknown')
        ON CONFLICT(filing_id, document_id) DO NOTHING`,
      ).run(filingId, documentId, index);
      registerDocumentSource(
        db,
        documentId,
        filingId,
        job.target.fingerprint,
        now,
      );
      finalize(job, "completed", now);
      return documentId;
    }).immediate,
    fail: db.transaction((job, error, next) => {
      const now = utcIso(clock.now());
      owned(job, now);
      const retry = next && job.attempts < maxAttempts;
      finalize(
        job,
        retry ? "retry_wait" : "dead",
        now,
        retry ? utcIso(next) : now,
        error,
      );
      if (
        !retry &&
        job.target &&
        [
          "DOWNLOAD_INVALID_TYPE",
          "PDF_CORRUPT",
          "PDF_PASSWORD_PROTECTED",
          "PDF_TOO_MANY_PAGES",
        ].includes(error.code)
      ) {
        // A failed target only exhausts the current observation when every alternative is dead.
        db.prepare(
          `UPDATE source_filings SET classification = 'needs_document', reason_code = ?, updated_at = ?
          WHERE id = ? AND ingestion_fingerprint = ? AND classification = 'candidate' AND NOT EXISTS (
            SELECT 1 FROM download_targets t JOIN processing_jobs j ON j.entity_id = t.id AND j.step = 'download'
            WHERE t.filing_id = source_filings.id AND t.fingerprint = source_filings.ingestion_fingerprint AND j.status <> 'dead'
          )`,
        ).run(error.code, now, job.target.filing_id, job.target.fingerprint);
      }
      return retry ? "retry_wait" : "dead";
    }).immediate,
    release(job) {
      const now = utcIso(clock.now());
      if (guard.get(job.id, job.lease_owner, now))
        finalize(job, "queued", now, now, {}, 1);
    },
    counts() {
      return Object.fromEntries(
        db
          .prepare(
            "SELECT status, count(*) AS count FROM processing_jobs WHERE step = 'download' GROUP BY status",
          )
          .all()
          .map(({ status, count }) => [status, count]),
      );
    },
  };
}
