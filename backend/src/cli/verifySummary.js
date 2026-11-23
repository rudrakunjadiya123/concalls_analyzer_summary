import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { summarySchema, summaryEventSchema } from "@finosauras/shared";
import { readConfig } from "../config/env.js";
import { openDatabase } from "../db/connection.js";
import { migrateDatabase } from "../db/migrate.js";
import { decodeJson } from "../db/queries.js";
import { PipelineError, publicError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import { loadExtraction } from "../pdf/artifacts.js";
import { draftSchema } from "../ai/contracts.js";
import { evidenceUnits } from "../ai/chunk.js";
import { renderMarkdown } from "../summary/markdown.js";
import { synthesisInput, verifySelection } from "../summary/verify.js";
import { summaryOutputFingerprint } from "../summary/publish.js";

const unsupported = () => new PipelineError("AI_EVIDENCE_UNSUPPORTED");

/** Independently recheck persisted public artifacts against their private extraction checkpoint. */
export async function verifyStoredSummary(
  db,
  config,
  id,
  { show = false } = {},
) {
  const summary = db
    .prepare(
      `SELECT s.*,d.id AS document_id,d.sha256,t.clean_text_sha256,
    v.version_number,t.company_id FROM summaries s JOIN transcripts t ON t.id=s.transcript_id
    JOIN documents d ON d.id=t.document_id JOIN event_transcripts v ON v.transcript_id=t.id WHERE s.id=?`,
    )
    .get(id);
  if (!summary) throw new PipelineError("NOT_FOUND");
  const run = db
    .prepare(
      `SELECT draft_json,input_fingerprint FROM ai_runs WHERE transcript_id=? AND prompt_version=?
    AND model_id=? AND ai_provider=?`,
    )
    .get(
      summary.transcript_id,
      summary.prompt_version,
      summary.model_id,
      summary.ai_provider,
    );
  if (
    !run?.draft_json ||
    !run.input_fingerprint ||
    run.input_fingerprint !== summary.input_fingerprint ||
    summary.validation_status !== "passed"
  )
    throw unsupported();
  const draft = decodeJson(draftSchema, run.draft_json);
  const extraction = await loadExtraction(
    { id: summary.document_id, sha256: summary.sha256 },
    config,
  );
  if (
    !extraction ||
    extraction.manifest.clean_text_sha256 !== summary.clean_text_sha256
  )
    throw unsupported();
  const units = evidenceUnits(extraction.manifest);
  const checked = synthesisInput(
    draft.mapped_facts,
    units,
    extraction.manifest,
  );
  const expected = verifySelection(
    draft.selection,
    checked,
    units,
    draft.trusted,
  );
  const stored = decodeJson(summarySchema, summary.json_payload);
  const evidence = db
    .prepare(
      `SELECT claim_path,page_number,speaker,supporting_quote,source_block_id,
    supporting_quote_hash,verification_status FROM summary_evidence WHERE summary_id=? ORDER BY rowid`,
    )
    .all(id)
    .map(({ supporting_quote_hash, verification_status, ...row }) => {
      if (
        verification_status !== "verified" ||
        sha256(row.supporting_quote) !== supporting_quote_hash
      )
        throw unsupported();
      return row;
    });
  const expectedMarkdown = renderMarkdown(expected.summary, {
    isMock: Boolean(summary.is_mock),
  });
  if (
    JSON.stringify(stored) !== JSON.stringify(expected.summary) ||
    summary.markdown_payload !== expectedMarkdown ||
    JSON.stringify(evidence) !== JSON.stringify(expected.evidence) ||
    summaryOutputFingerprint(stored, expectedMarkdown, evidence) !==
      summary.output_fingerprint
  )
    throw unsupported();
  const event = db
    .prepare(
      "SELECT id,type,event_uuid,payload_json,created_at FROM outbox_events WHERE summary_id=?",
    )
    .get(id);
  if (!event) throw new PipelineError("OUTBOX_PUBLISH_FAILURE");
  const payload = decodeJson(summaryEventSchema, event.payload_json);
  if (
    payload.event_id !== event.id ||
    payload.type !== event.type ||
    payload.event_uuid !== event.event_uuid ||
    payload.emitted_at !== event.created_at ||
    event.created_at !== summary.published_at ||
    payload.data.summary_id !== id ||
    payload.data.is_mock !== Boolean(summary.is_mock) ||
    payload.data.revision !== summary.version_number ||
    payload.data.company_id !== summary.company_id ||
    payload.data.concall_event_id !== summary.event_id ||
    payload.data_mode !== draft.trusted.dataMode ||
    JSON.stringify(payload.data.summary) !== JSON.stringify(stored)
  )
    throw unsupported();
  return {
    summary_id: id,
    status: "verified",
    is_mock: Boolean(summary.is_mock),
    provider: summary.ai_provider,
    model: summary.model_id,
    revision: summary.version_number,
    evidence_count: evidence.length,
    outbox_event_id: event.id,
    output_fingerprint: summary.output_fingerprint,
    ...(show ? { summary: stored, markdown: expectedMarkdown } : {}),
  };
}

async function main() {
  let db;
  try {
    const { values } = parseArgs({
      options: { id: { type: "string" }, show: { type: "boolean" } },
    });
    const id = z.uuid().safeParse(values.id);
    if (!id.success) throw new PipelineError("CONFIG_INVALID");
    const config = readConfig();
    db = openDatabase(config);
    migrateDatabase(db);
    console.log(
      JSON.stringify(
        await verifyStoredSummary(db, config, id.data, { show: values.show }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
