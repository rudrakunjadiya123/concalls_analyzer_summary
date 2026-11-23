import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readConfig } from "../config/env.js";
import { openDatabase } from "../db/connection.js";
import { decodeJson } from "../db/queries.js";
import { migrateDatabase } from "../db/migrate.js";
import { PipelineError, publicError } from "../core/errors.js";
import { extractionQualitySchema } from "../pdf/artifacts.js";
import { reviewMetadataSchema } from "../transcript/canonicalize.js";

/** Return useful local diagnostics while keeping private transcript text, URLs and storage paths out. */
export function inspectTranscript(db, id) {
  const document = db
    .prepare(
      `SELECT d.id, p.extraction_version, p.status, p.page_count, p.quality_json, p.error_code
    FROM documents d LEFT JOIN pdf_extractions p ON d.id=p.document_id WHERE d.id=?`,
    )
    .get(id);
  if (!document) throw new PipelineError("NOT_FOUND");
  const reviews = db
    .prepare(
      `SELECT r.classification,r.role,r.reason_code,r.confidence,r.decision,r.metadata_json,
    f.source,r.transcript_id,v.event_id,v.version_number,v.revision_kind,v.is_current
    FROM document_reviews r JOIN document_sources s ON s.id=r.source_id JOIN source_filings f ON f.id=s.filing_id
    LEFT JOIN event_transcripts v ON v.transcript_id=r.transcript_id WHERE s.document_id=? ORDER BY r.updated_at, s.id`,
    )
    .all(id)
    .map(({ metadata_json: json, ...row }) => {
      const {
        call_date,
        quarter,
        period_end,
        company_confirmed,
        warnings,
        metadata_provenance,
      } = decodeJson(reviewMetadataSchema, json);
      return {
        ...row,
        call_date,
        quarter,
        period_end,
        company_confirmed,
        warnings,
        provenance_locations: metadata_provenance.map(
          ({ field, source, page_number, line_number, confidence }) => ({
            field,
            source,
            page_number,
            line_number,
            confidence,
          }),
        ),
      };
    });
  const { quality_json: quality, ...detail } = document;
  return {
    ...detail,
    status: detail.status ?? "pending",
    quality: quality ? decodeJson(extractionQualitySchema, quality) : null,
    reviews,
  };
}

function main() {
  let db;
  try {
    const { values } = parseArgs({
      options: { "document-id": { type: "string" } },
    });
    const id = z.uuid().safeParse(values["document-id"]);
    if (!id.success) throw new PipelineError("CONFIG_INVALID");
    db = openDatabase(readConfig());
    migrateDatabase(db);
    console.log(JSON.stringify(inspectTranscript(db, id.data), null, 2));
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
