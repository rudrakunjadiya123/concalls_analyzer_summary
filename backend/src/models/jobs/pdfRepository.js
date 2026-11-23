import { randomUUID } from "node:crypto";
import { normalizedFilingSchema, rawMetadataSchema } from "@finosauras/shared";
import { PipelineError } from "../../utils/errors.js";
import { systemClock, utcIso } from "../../utils/clock.js";
import { encodeJson, decodeJson } from "../queries.js";
import { EXTRACTION_VERSION } from "../../services/pdf/extract.js";
import { extractionQualitySchema } from "../../services/pdf/artifacts.js";
import {
  canonicalizeTranscript,
  reviewMetadataSchema,
} from "../../services/transcript/canonicalize.js";

function queue(db, step, entity, now) {
  db.prepare(
    `INSERT INTO processing_jobs
    (id, job_key, kind, entity_id, step, status, attempts, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?) ON CONFLICT(job_key) DO NOTHING`,
  ).run(
    randomUUID(),
    `${step}:${EXTRACTION_VERSION}:${entity}`,
    step === "extract" ? "pdf_document" : "document_source",
    entity,
    step,
    now,
    now,
    now,
  );
}

/** Record the immutable attachment observation and enqueue the next durable step in the caller's transaction. */
export function registerDocumentSource(
  db,
  documentId,
  filingId,
  fingerprint,
  now,
) {
  db.prepare(
    `INSERT INTO document_sources VALUES (?, ?, ?, ?) ON CONFLICT(document_id, filing_id, fingerprint) DO NOTHING`,
  ).run(randomUUID(), documentId, filingId, fingerprint);
  const source = db
    .prepare(
      "SELECT id FROM document_sources WHERE document_id = ? AND filing_id = ? AND fingerprint = ?",
    )
    .get(documentId, filingId, fingerprint);
  const extracted = db
    .prepare(
      "SELECT 1 FROM pdf_extractions WHERE document_id = ? AND extraction_version = ?",
    )
    .get(documentId, EXTRACTION_VERSION);
  queue(
    db,
    extracted ? "classify" : "extract",
    extracted ? source.id : documentId,
    now,
  );
}

/** Queue pre-Stage-3 attachments so a database upgrade resumes completed downloads in place. */
export function backfillDocumentSources(db, now) {
  db.transaction(() => {
    const missing = db
      .prepare(
        `SELECT f.filing_id, f.document_id, coalesce(t.fingerprint, '') AS fingerprint
      FROM filing_documents f JOIN documents d ON d.id = f.document_id AND d.validation_status = 'validated'
      LEFT JOIN download_cache c ON c.document_id = f.document_id
      LEFT JOIN download_targets t ON t.cache_key = c.cache_key AND t.filing_id = f.filing_id
        AND EXISTS (SELECT 1 FROM processing_jobs j WHERE j.entity_id = t.id AND j.step = 'download' AND j.status = 'completed')
      WHERE NOT EXISTS (SELECT 1 FROM document_sources s WHERE s.filing_id = f.filing_id AND s.document_id = f.document_id)
      GROUP BY f.filing_id, f.document_id, t.fingerprint ORDER BY t.fingerprint DESC`,
      )
      .all();
    const recorded = new Set();
    for (const row of missing) {
      const pair = `${row.filing_id}:${row.document_id}`;
      if (!row.fingerprint && recorded.has(pair)) continue;
      registerDocumentSource(
        db,
        row.document_id,
        row.filing_id,
        row.fingerprint,
        now,
      );
      recorded.add(pair);
    }
  }).immediate();
}

function recomputeFiling(db, filingId, documentId, now) {
  const current = db
    .prepare("SELECT ingestion_fingerprint FROM source_filings WHERE id = ?")
    .get(filingId).ingestion_fingerprint;
  const sources = db
    .prepare(
      `SELECT r.* FROM document_sources s LEFT JOIN document_reviews r ON r.source_id = s.id
    WHERE s.filing_id = ? AND (s.fingerprint = coalesce(?, '') OR s.fingerprint = '')`,
    )
    .all(filingId, current);
  const roles = db
    .prepare(
      `SELECT r.role FROM document_sources s JOIN document_reviews r ON r.source_id = s.id
    WHERE s.filing_id = ? AND s.document_id = ?`,
    )
    .all(filingId, documentId)
    .map((row) => row.role);
  const role =
    ["transcript", "cover_letter", "other", "unknown"].find((value) =>
      roles.includes(value),
    ) ?? "unknown";
  db.prepare(
    "UPDATE filing_documents SET role = ? WHERE filing_id = ? AND document_id = ?",
  ).run(role, filingId, documentId);
  let outcome = sources.find(
    ({ classification }) => classification === "confirmed_transcript",
  );
  if (!outcome) {
    if (
      !sources.length ||
      sources.some(({ classification }) => !classification) ||
      db
        .prepare(
          `SELECT 1 FROM download_targets t JOIN processing_jobs j ON t.id = j.entity_id
        WHERE t.filing_id = ? AND t.fingerprint = ? AND j.step = 'download'
        AND j.status IN ('running','queued','retry_wait') LIMIT 1`,
        )
        .get(filingId, current)
    )
      return;
    outcome =
      sources.find(
        ({ classification }) => classification === "needs_document",
      ) ??
      sources.find(({ classification }) => classification === "unsupported") ??
      sources[0];
  }
  db.prepare(
    "UPDATE source_filings SET classification = ?, reason_code = ?, updated_at = ? WHERE id = ?",
  ).run(outcome.classification, outcome.reason_code, now, filingId);
}

/** Transactional lease handling and terminal state updates for the local PDF stages. */
export function createPdfRepository(
  db,
  { leaseSeconds, maxAttempts, clock = systemClock },
) {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?");
  const now = () => utcIso(clock.now());
  const expires = () =>
    utcIso(new Date(clock.now().getTime() + leaseSeconds * 1000));
  const assertOwner = (job) => {
    if (
      !db
        .prepare(
          `SELECT 1 FROM processing_jobs WHERE id = ? AND step = ? AND status = 'running'
      AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .get(job.id, job.step, job.lease_owner, now())
    )
      throw new PipelineError("JOB_LEASE_LOST");
  };
  const settle = (job, status, next = now(), error = null, release = 0) => {
    db.prepare(
      `UPDATE processing_jobs SET status = ?, next_run_at = ?, updated_at = ?, last_error_code = ?,
      last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, attempts = attempts - ?
      WHERE id = ? AND lease_owner = ?`,
    ).run(
      status,
      next,
      now(),
      error?.code ?? null,
      error?.message ?? null,
      release,
      job.id,
      job.lease_owner,
    );
  };
  const saveExtraction = (id, status, artifact, code) => {
    db.prepare(
      `INSERT INTO pdf_extractions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET extraction_version=excluded.extraction_version,
      status=excluded.status, page_count=excluded.page_count, clean_text_sha256=excluded.clean_text_sha256,
      page_map_path=excluded.page_map_path, quality_json=excluded.quality_json, error_code=excluded.error_code,
      updated_at=excluded.updated_at`,
    ).run(
      id,
      EXTRACTION_VERSION,
      status,
      artifact?.manifest.page_count ?? null,
      artifact?.manifest.clean_text_sha256 ?? null,
      artifact?.paths.pages ?? null,
      artifact
        ? encodeJson(extractionQualitySchema, artifact.manifest.quality)
        : null,
      code,
      now(),
    );
    for (const source of db
      .prepare("SELECT id FROM document_sources WHERE document_id = ?")
      .all(id))
      queue(db, "classify", source.id, now());
  };

  return {
    claim: db.transaction(() => {
      const instant = now();
      const recovered = db
        .prepare(
          `UPDATE processing_jobs SET status = CASE WHEN attempts > ? THEN 'dead' ELSE 'retry_wait' END,
        lease_owner=NULL, lease_expires_at=NULL, next_run_at=?, updated_at=?, last_error_code='JOB_LEASE_LOST',
        last_error_message='Expired PDF job lease recovered'
        WHERE step IN ('extract','classify') AND status='running' AND lease_expires_at <= ?
        RETURNING entity_id, step, status`,
        )
        .all(maxAttempts, instant, instant, instant);
      for (const job of recovered) {
        if (
          job.step === "extract" &&
          job.status === "dead" &&
          document.get(job.entity_id)
        )
          saveExtraction(job.entity_id, "failed", null, "JOB_LEASE_LOST");
      }
      // Prioritize extracting bytes once; then review observations in filing order where known.
      return db
        .prepare(
          `UPDATE processing_jobs SET status='running', attempts=attempts+1, lease_owner=@owner,
        lease_expires_at=@expires, updated_at=@now WHERE id = (
          SELECT j.id FROM processing_jobs j LEFT JOIN document_sources s ON s.id=j.entity_id AND j.step='classify'
          LEFT JOIN source_filings f ON s.filing_id=f.id LEFT JOIN filing_observations o
            ON s.filing_id=o.filing_id AND s.fingerprint=o.fingerprint
          WHERE j.step IN ('extract','classify') AND j.status IN ('queued','retry_wait')
            AND j.next_run_at <= @now AND j.attempts <= @attempts
          ORDER BY CASE j.step WHEN 'extract' THEN 0 ELSE 1 END,
            coalesce(json_extract(o.normalized_json, '$.publishedAt'), f.filing_published_at, j.created_at), j.id LIMIT 1
        ) RETURNING *`,
        )
        .get({
          owner: randomUUID(),
          expires: expires(),
          now: instant,
          attempts: maxAttempts,
        });
    }).immediate,
    document: (id) => document.get(id),
    context(sourceId) {
      const source = db
        .prepare("SELECT * FROM document_sources WHERE id = ?")
        .get(sourceId);
      const current = db
        .prepare("SELECT * FROM source_filings WHERE id = ?")
        .get(source.filing_id);
      const snapshot = db
        .prepare(
          "SELECT normalized_json FROM filing_observations WHERE filing_id = ? AND fingerprint = ?",
        )
        .get(source.filing_id, source.fingerprint);
      let filing = {
        ...current,
        raw: decodeJson(rawMetadataSchema, current.raw_metadata_json),
      };
      if (snapshot) {
        const row = decodeJson(
          normalizedFilingSchema,
          snapshot.normalized_json,
        );
        filing = {
          ...filing,
          subject: row.subject,
          description: row.description,
          raw: row.raw,
          filing_published_at: row.publishedAt,
          call_date_hint: row.callDateHint,
          quarter_hint: row.quarterHint,
          reported_isin: row.company.isin,
        };
      } else if (current.ingestion_fingerprint) {
        // Legacy links with no provable observation cannot inherit a later correction or call hint.
        filing = {
          ...filing,
          subject: "",
          description: "",
          filing_published_at: null,
          call_date_hint: null,
          quarter_hint: null,
        };
      }
      return {
        source,
        document: document.get(source.document_id),
        filing,
        extraction: db
          .prepare("SELECT * FROM pdf_extractions WHERE document_id = ?")
          .get(source.document_id),
        company: db
          .prepare("SELECT * FROM companies WHERE id = ?")
          .get(filing.company_id),
        watchlist: db.prepare("SELECT * FROM companies").all(),
      };
    },
    renew(job) {
      return Boolean(
        db
          .prepare(
            `UPDATE processing_jobs SET lease_expires_at=?, updated_at=?
        WHERE id=? AND step=? AND status='running' AND lease_owner=? AND lease_expires_at > ?`,
          )
          .run(expires(), now(), job.id, job.step, job.lease_owner, now())
          .changes,
      );
    },
    finishExtract: db.transaction((job, artifact) => {
      assertOwner(job);
      saveExtraction(job.entity_id, "extracted", artifact, null);
      settle(job, "completed");
    }).immediate,
    finishReview: db.transaction(
      (job, context, artifact, decision, metadata) => {
        assertOwner(job);
        const timestamp = now();
        const verdict =
          metadata.warnings.includes("company_conflict") ||
          (decision.role === "transcript" && !metadata.company_confirmed)
            ? {
                ...decision,
                classification: "needs_document",
                role: "unknown",
                reason: "COMPANY_IDENTITY_CONFLICT",
                confidence: "low",
              }
            : decision;
        const canonical = artifact
          ? canonicalizeTranscript(db, {
              ...context,
              extraction: artifact,
              metadata,
              verdict,
              now: timestamp,
            })
          : { decision: verdict.reason, transcriptId: null };
        const issuerConflict = canonical.decision === "company_identity_review";
        const unresolvedMirror =
          canonical.decision === "cross_exchange_metadata_review";
        const details = {
          ...metadata,
          filing_published_at: context.filing.filing_published_at,
          signals: verdict.signals,
        };
        db.prepare(
          `INSERT INTO document_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO NOTHING`,
        ).run(
          context.source.id,
          issuerConflict || unresolvedMirror
            ? "needs_document"
            : verdict.classification,
          issuerConflict || unresolvedMirror ? "unknown" : verdict.role,
          issuerConflict
            ? "COMPANY_IDENTITY_CONFLICT"
            : unresolvedMirror
              ? "cross_exchange_metadata_unconfirmed"
              : verdict.reason,
          issuerConflict || unresolvedMirror ? "low" : verdict.confidence,
          canonical.decision,
          canonical.transcriptId,
          encodeJson(reviewMetadataSchema, details),
          timestamp,
        );
        recomputeFiling(db, context.filing.id, context.document.id, timestamp);
        settle(job, "completed");
      },
    ).immediate,
    fail: db.transaction((job, error, next) => {
      assertOwner(job);
      const retry = next && job.attempts < maxAttempts;
      if (!retry && job.step === "extract" && document.get(job.entity_id))
        saveExtraction(job.entity_id, "failed", null, error.code);
      settle(
        job,
        retry ? "retry_wait" : "dead",
        retry ? utcIso(next) : now(),
        error,
      );
    }).immediate,
    release: db.transaction((job) => {
      assertOwner(job);
      settle(job, "queued", now(), null, 1);
    }).immediate,
    counts() {
      const result = { extract: {}, classify: {}, reviews: {} };
      for (const row of db
        .prepare(
          "SELECT step,status,count(*) AS count FROM processing_jobs WHERE step IN ('extract','classify') GROUP BY step,status",
        )
        .all())
        result[row.step][row.status] = row.count;
      for (const row of db
        .prepare(
          "SELECT decision,count(*) AS count FROM document_reviews GROUP BY decision",
        )
        .all())
        result.reviews[row.decision] = row.count;
      return result;
    },
  };
}
