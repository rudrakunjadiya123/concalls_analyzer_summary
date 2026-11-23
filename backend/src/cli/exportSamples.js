import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { verifyStoredSummary } from "./verifySummary.js";
import { readConfig } from "../config/env.js";
import { openDatabase } from "../config/database.js";
import { migrateDatabase } from "../models/migrate.js";
import { loadExtraction } from "../services/pdf/artifacts.js";
import { atomicWrite, readPrivateFile } from "../utils/storage.js";
import { PipelineError, publicError } from "../utils/errors.js";
import { sha256 } from "../utils/hash.js";

const grant = z.strictObject({
  summary_id: z.uuid(),
  document_sha256: z.string().regex(/^[a-f\d]{64}$/u),
  source_url: z.url(),
  redistribution_allowed: z.literal(true),
  authorization_reference: z.string().trim().min(1).max(500),
});
const json = (value) => JSON.stringify(value, null, 2) + "\n";

/** Bundle one explicitly approved real publication under DATA_DIR. The manifest is written last. */
export async function exportApprovedSample(db, config, input) {
  const permission = grant.parse(input);
  const row = db
    .prepare(
      `SELECT s.id,s.published_at,s.model_id,s.prompt_version,s.validation_report_json,
    t.document_id,t.extraction_version,d.sha256,d.downloaded_at,c.display_name,c.nse_symbol,c.bse_scrip_code,c.isin,c.identity_verified_at
    FROM summaries s JOIN outbox_events o ON o.summary_id=s.id JOIN transcripts t ON t.id=s.transcript_id
    JOIN documents d ON d.id=t.document_id JOIN companies c ON c.id=t.company_id
    WHERE s.id=? AND s.validation_status='passed' AND s.published_at IS NOT NULL AND c.identity_verified_at IS NOT NULL
      AND s.ai_provider='gemini' AND s.is_mock=0
      AND json_extract(o.payload_json,'$.data_mode') IN ('authorized-direct','licensed-feed')`,
    )
    .get(permission.summary_id);
  if (!row || row.sha256 !== permission.document_sha256)
    throw new PipelineError(
      "SOURCE_NOT_AUTHORIZED",
      "A matching verified real source and redistribution grant are required",
    );
  const verified = await verifyStoredSummary(db, config, row.id, {
    show: true,
  });
  const { summary } = verified;
  if (
    summary.source_url !== permission.source_url ||
    summary.source === "FIXTURE"
  )
    throw new PipelineError("SOURCE_NOT_AUTHORIZED");
  const extraction = await loadExtraction(
    { id: row.document_id, sha256: row.sha256 },
    config,
  );
  if (!extraction) throw new PipelineError("AI_EVIDENCE_UNSUPPORTED");
  const raw = await readPrivateFile(config.DATA_DIR, extraction.paths.raw, {
    maxBytes: 64 * 1024 * 1024,
  });
  if (sha256(raw) !== extraction.manifest.raw_sha256)
    throw new PipelineError("AI_EVIDENCE_UNSUPPORTED");
  const evidence = db
    .prepare(
      `SELECT claim_path,page_number,speaker,supporting_quote,source_block_id,verification_status
    FROM summary_evidence WHERE summary_id=? ORDER BY rowid`,
    )
    .all(row.id);
  const partition =
    summary.quarter?.replace(" ", "-") ??
    summary.call_date ??
    "date-unconfirmed";
  const key = `exports/samples/${summary.nse_symbol ?? summary.scrip_code ?? "identity"}/${partition}/${row.id}`;
  await atomicWrite(config.DATA_DIR, `${key}/raw_transcript.txt`, raw);
  await atomicWrite(config.DATA_DIR, `${key}/summary.json`, json(summary));
  await atomicWrite(config.DATA_DIR, `${key}/summary.md`, verified.markdown);
  await atomicWrite(config.DATA_DIR, `${key}/evidence.json`, json(evidence));
  await atomicWrite(
    config.DATA_DIR,
    `${key}/manifest.json`,
    json({
      summary_id: row.id,
      company: summary.company,
      source: summary.source,
      source_url: summary.source_url,
      identity: {
        display_name: row.display_name,
        nse_symbol: row.nse_symbol,
        bse_scrip_code: row.bse_scrip_code,
        isin: row.isin,
        verified_at: row.identity_verified_at,
      },
      sources: JSON.parse(row.validation_report_json).sources,
      quarter: summary.quarter,
      call_date: summary.call_date,
      retrieved_at: row.downloaded_at,
      published_at: row.published_at,
      document_sha256: row.sha256,
      raw_transcript_sha256: sha256(raw),
      extraction_version: row.extraction_version,
      model: row.model_id,
      prompt_version: row.prompt_version,
      source_permissions: {
        redistribution_allowed: true,
        authorization_reference: permission.authorization_reference,
      },
      validation_status: verified.status,
      evidence_count: verified.evidence_count,
      is_mock: false,
    }),
  );
  return { summary_id: row.id, status: "exported", export_directory: key };
}

async function main() {
  let db;
  try {
    const { values } = parseArgs({
      options: { permissions: { type: "string" } },
    });
    if (!values.permissions)
      throw new PipelineError(
        "SOURCE_NOT_AUTHORIZED",
        "Supply a local --permissions file for a verified real transcript",
      );
    const permissions = z
      .array(grant)
      .min(1)
      .max(50)
      .parse(JSON.parse(await readFile(values.permissions, "utf8")));
    const config = readConfig();
    db = openDatabase(config);
    migrateDatabase(db);
    for (const permission of permissions)
      console.log(
        json(await exportApprovedSample(db, config, permission)).trim(),
      );
  } catch (error) {
    console.error(
      json(
        publicError(
          error instanceof z.ZodError || error instanceof SyntaxError
            ? new PipelineError("BAD_REQUEST", "Invalid sample permission file")
            : error,
        ),
      ).trim(),
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
