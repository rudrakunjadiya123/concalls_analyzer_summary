import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encodeJson } from "../db/queries.js";
import { extractionQualitySchema } from "../pdf/artifacts.js";

export const reviewMetadataSchema = z.strictObject({
  call_date: z.string().nullable(),
  quarter: z.string().nullable(),
  period_end: z.string().nullable(),
  company_confirmed: z.boolean(),
  normalized_title: z.string(),
  warnings: z.array(z.string()),
  metadata_provenance: z.array(
    z.strictObject({
      field: z.enum(["company", "call_date", "quarter", "period_end"]),
      value: z.string(),
      source: z.enum(["pdf", "filing_structured", "filing_description"]),
      source_filing_id: z.string().nullable(),
      page_number: z.int().positive().nullable(),
      line_number: z.int().positive().nullable(),
      raw_expression: z.string(),
      confidence: z.enum(["high", "medium"]),
    }),
  ),
  filing_published_at: z.string().nullable(),
  signals: z.record(z.string(), z.union([z.boolean(), z.number()])),
});

const revised =
  /\b(?:corrigendum|correct(?:ed|ion)|revis(?:ed|ion)|updated\s+transcript)\b/iu;
const generic =
  /\b(?:the|a|an|of|for|to|synthetic|test|company|earnings|results|investor|analyst|conference|call|concall|transcript|quarterly|financial|fy\d+|q[1-4]|\d+)\b/gu;

/** Link exact complete-text duplicates and immutable revisions without advancing a published pointer. */
export function canonicalizeTranscript(
  db,
  { document, company, filing, extraction, metadata, verdict, now },
) {
  const review = (decision, transcriptId = null) => ({
    decision,
    transcriptId,
  });
  if (verdict.classification !== "confirmed_transcript")
    return review(verdict.reason);
  if (!metadata.company_confirmed) return review("company_identity_review");

  const { manifest, paths, characterCount } = extraction;
  const alias = db
    .prepare(
      `SELECT t.* FROM transcript_documents td JOIN transcripts t ON t.id = td.transcript_id
    WHERE td.document_id = ?`,
    )
    .get(document.id);
  const byDocument =
    alias ??
    db
      .prepare("SELECT * FROM transcripts WHERE document_id = ?")
      .get(document.id);
  if (byDocument && byDocument.company_id !== company.id) {
    metadata.warnings.push("document_company_conflict");
    return review("company_identity_review");
  }
  const same =
    byDocument ??
    db
      .prepare(
        `SELECT * FROM transcripts WHERE company_id = ? AND clean_text_sha256 = ?
    ORDER BY created_at, id LIMIT 1`,
      )
      .get(company.id, manifest.clean_text_sha256);
  if (
    !same &&
    filing.source !== "FIXTURE" &&
    db
      .prepare(
        "SELECT 1 FROM transcripts WHERE clean_text_sha256 = ? AND company_id <> ? LIMIT 1",
      )
      .get(manifest.clean_text_sha256, company.id)
  ) {
    // The full text can identify a mirror, but it cannot reconcile conflicting issuer IDs.
    metadata.warnings.push("transcript_text_company_conflict");
    return review("company_identity_review");
  }
  const link = db.prepare(`INSERT INTO transcript_documents VALUES (?, ?, ?, ?)
    ON CONFLICT(document_id) DO NOTHING`);
  if (same) {
    link.run(
      document.id,
      same.id,
      same.document_id === document.id ? "original" : "duplicate_text",
      now,
    );
    if (
      metadata.warnings.some((warning) => warning.endsWith("_conflict")) ||
      (metadata.call_date &&
        same.detected_call_date &&
        metadata.call_date !== same.detected_call_date) ||
      (metadata.quarter &&
        same.detected_quarter &&
        metadata.quarter !== same.detected_quarter) ||
      (metadata.period_end &&
        same.period_end &&
        metadata.period_end !== same.period_end)
    ) {
      metadata.warnings.push("duplicate_metadata_conflict");
      return review("metadata_review", same.id);
    }
    return review(
      same.document_id === document.id ? "existing_document" : "duplicate_text",
      same.id,
    );
  }

  const isCorrection = revised.test(`${filing.subject} ${filing.description}`);
  const comparable =
    metadata.call_date && metadata.normalized_title
      ? db
          .prepare(
            `
    SELECT e.*,
      (SELECT max(json_extract(r.metadata_json, '$.filing_published_at'))
       FROM event_transcripts v JOIN document_reviews r ON r.transcript_id = v.transcript_id WHERE v.event_id = e.id) AS latest_filing,
      EXISTS(SELECT 1 FROM event_transcripts v JOIN document_reviews r ON r.transcript_id = v.transcript_id
       JOIN document_sources s ON s.id = r.source_id WHERE v.event_id = e.id AND s.filing_id = @filing) AS same_filing
    FROM concall_events e WHERE e.company_id = @company AND e.call_date = @date AND e.normalized_title = @title
  `,
          )
          .all({
            filing: filing.id,
            company: company.id,
            date: metadata.call_date,
            title: metadata.normalized_title,
          })
      : [];
  const hasConflict = metadata.warnings.some((warning) =>
    warning.endsWith("_conflict"),
  );
  const specificTitle =
    metadata.normalized_title.replace(generic, "").trim().length >= 6;
  const eligible =
    isCorrection && !hasConflict
      ? comparable.filter((event) => {
          const sameQuarter =
            metadata.quarter && event.quarter === metadata.quarter;
          const samePeriod =
            metadata.period_end && event.period_end === metadata.period_end;
          const compatible =
            (!event.quarter || !metadata.quarter || sameQuarter) &&
            (!event.period_end || !metadata.period_end || samePeriod);
          return (
            compatible &&
            Boolean(
              event.latest_filing &&
              filing.filing_published_at &&
              filing.filing_published_at > event.latest_filing &&
              (event.same_filing ||
                (specificTitle && (samePeriod || sameQuarter))),
            )
          );
        })
      : [];
  const prior =
    eligible.length === 1 && comparable.length === 1 ? eligible[0] : null;
  const ambiguous =
    !prior && (isCorrection || comparable.length > 0 || hasConflict);
  const needsReview =
    ambiguous ||
    metadata.warnings.length > 0 ||
    verdict.confidence !== "high" ||
    manifest.quality.warnings.includes("mixed_image_pages");
  if (ambiguous) metadata.warnings.push("event_identity_uncertain");

  const transcriptId = randomUUID();
  db.prepare(
    `INSERT INTO transcripts
    (id, document_id, company_id, extraction_version, raw_text_path, clean_text_path, page_map_path,
     clean_text_sha256, page_count, character_count, extraction_quality_json, transcript_confidence,
     language, detected_call_date, detected_quarter, period_end, stage_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transcriptId,
    document.id,
    company.id,
    manifest.extraction_version,
    paths.raw,
    paths.clean,
    paths.pages,
    manifest.clean_text_sha256,
    manifest.page_count,
    characterCount,
    encodeJson(extractionQualitySchema, manifest.quality),
    verdict.confidence,
    metadata.call_date,
    metadata.quarter,
    metadata.period_end,
    needsReview ? "needs_review" : "classified",
    now,
    now,
  );
  link.run(document.id, transcriptId, "original", now);
  const eventId = prior?.id ?? randomUUID();
  if (!prior)
    db.prepare(
      `INSERT INTO concall_events
    (id, company_id, call_date, quarter, period_end, normalized_title, event_identity_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      company.id,
      metadata.call_date,
      metadata.quarter,
      metadata.period_end,
      metadata.normalized_title,
      `text:${manifest.clean_text_sha256}`,
      now,
      now,
    );
  const version = prior
    ? db
        .prepare(
          "SELECT max(version_number) + 1 AS next FROM event_transcripts WHERE event_id = ?",
        )
        .get(eventId).next
    : 1;
  const current = !prior && !ambiguous ? 1 : 0;
  db.prepare("INSERT INTO event_transcripts VALUES (?, ?, ?, ?, ?, ?)").run(
    eventId,
    transcriptId,
    version,
    prior ? "correction" : ambiguous ? "unknown" : "original",
    current,
    now,
  );
  // A verified correction remains pending until Stage 4 can validate publication atomically.
  if (current)
    db.prepare(
      "UPDATE concall_events SET current_transcript_id = ? WHERE id = ?",
    ).run(transcriptId, eventId);
  return review(
    prior
      ? "revision_pending"
      : ambiguous
        ? "ambiguous_revision"
        : needsReview
          ? "metadata_review"
          : "original",
    transcriptId,
  );
}
