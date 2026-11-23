import { randomUUID } from "node:crypto";
import { z } from "zod";
import { summarySchema, summaryEventSchema } from "@finosauras/shared";
import { AI_PROVIDERS } from "@finosauras/shared/constants";
import { encodeJson } from "../../models/queries.js";
import { sha256 } from "../../utils/hash.js";
import { PipelineError } from "../../utils/errors.js";
import { evidenceRowSchema } from "../ai/contracts.js";
import { GEMINI_PROMPT_VERSION } from "../ai/prompts.js";
import { renderMarkdown } from "./markdown.js";

export const summaryOutputFingerprint = (summary, markdown, evidence) =>
  sha256(JSON.stringify({ summary, markdown, evidence }));

const reportSchema = z.strictObject({
  warnings: z.array(z.string()),
  rejected: z.record(z.string(), z.int().nonnegative()),
  coverage: z.record(
    z.string(),
    z.strictObject({
      available: z.int().nonnegative(),
      included: z.int().nonnegative(),
    }),
  ),
  provider: z.enum(AI_PROVIDERS),
  estimated_input_tokens: z.int().nonnegative(),
  reported_input_tokens: z.int().nonnegative(),
  reported_output_tokens: z.int().nonnegative(),
  generated_at: z.iso.datetime(),
  evidence_count: z.int().positive(),
  sources: z.array(z.json()),
});

/** Called inside the lease-checked publication transaction; every write commits together. */
export function publishVerified(db, { run, context, verified, now }) {
  const { row, trusted } = context;
  const requiredProvider = trusted.dataMode === "fixture" ? "mock" : "gemini";
  // Publication also guards provider identity for persisted drafts and resumed jobs.
  if (run.ai_provider !== requiredProvider)
    throw new PipelineError("AI_PROVIDER_RESTRICTED");
  const duplicate = db
    .prepare(
      `SELECT id FROM summaries WHERE transcript_id=? AND prompt_version=? AND model_id=? AND ai_provider=?`,
    )
    .get(row.id, run.prompt_version, run.model_id, run.ai_provider);
  if (duplicate) {
    if (
      !db
        .prepare("SELECT id FROM outbox_events WHERE summary_id=?")
        .get(duplicate.id)
    )
      throw new PipelineError("OUTBOX_PUBLISH_FAILURE");
    return duplicate.id;
  }
  const previous = db
    .prepare(
      `SELECT s.id, s.transcript_id, s.prompt_version, v.version_number FROM summaries s
    JOIN event_transcripts v ON v.transcript_id=s.transcript_id WHERE s.event_id=? AND s.is_current=1`,
    )
    .get(row.event_id);
  const latest = db
    .prepare(
      `SELECT max(version_number) AS version FROM event_transcripts
    WHERE event_id=? AND revision_kind IN ('original','correction')`,
    )
    .get(row.event_id).version;
  // An upgraded summary can replace its rendition of the same PDF. Its transcript revision stays unchanged.
  const upgraded =
    previous?.transcript_id === row.id &&
    run.prompt_version === GEMINI_PROMPT_VERSION &&
    previous.prompt_version !== GEMINI_PROMPT_VERSION;
  if (
    row.version_number !== latest ||
    (previous && !upgraded && row.version_number <= previous.version_number)
  )
    throw new PipelineError("AI_STALE_REVISION");
  const summary = summarySchema.parse(verified.summary);
  const isMock = run.ai_provider === "mock";
  const evidence = z.array(evidenceRowSchema).min(3).parse(verified.evidence);
  const markdown = renderMarkdown(summary, { isMock });
  const digest = summaryOutputFingerprint(summary, markdown, evidence);
  const report = {
    ...verified.report,
    provider: run.ai_provider,
    sources: trusted.sources,
    evidence_count: evidence.length,
    estimated_input_tokens: run.estimated_input_tokens,
    reported_input_tokens: run.reported_input_tokens,
    reported_output_tokens: run.reported_output_tokens,
    generated_at: now,
  };
  const id = randomUUID();
  // Deactivate prior current rows before inserting or promoting a corrected transcript.
  db.prepare(
    "UPDATE summaries SET is_current=0 WHERE event_id=? AND is_current=1",
  ).run(row.event_id);
  db.prepare(
    `INSERT INTO summaries (id,event_id,transcript_id,prompt_version,model_id,ai_provider,is_mock,
    json_payload,markdown_payload,validation_status,validation_report_json,is_current,created_at,published_at,input_fingerprint,output_fingerprint)
    VALUES (?,?,?,?,?,?,?, ?,?,'passed',?,1,?,?,?,?)`,
  ).run(
    id,
    row.event_id,
    row.id,
    run.prompt_version,
    run.model_id,
    run.ai_provider,
    Number(isMock),
    encodeJson(summarySchema, summary),
    markdown,
    encodeJson(reportSchema, report),
    now,
    now,
    run.input_fingerprint,
    digest,
  );
  const insert =
    db.prepare(`INSERT INTO summary_evidence (id,summary_id,claim_path,page_number,speaker,supporting_quote,
    supporting_quote_hash,verification_status,created_at,source_block_id) VALUES (?,?,?,?,?,?,?,'verified',?,?)`);
  for (const entry of evidence)
    insert.run(
      randomUUID(),
      id,
      entry.claim_path,
      entry.page_number,
      entry.speaker,
      entry.supporting_quote,
      sha256(entry.supporting_quote),
      now,
      entry.source_block_id,
    );
  db.prepare(
    "UPDATE event_transcripts SET is_current=0 WHERE event_id=? AND is_current=1",
  ).run(row.event_id);
  db.prepare(
    "UPDATE event_transcripts SET is_current=1 WHERE event_id=? AND transcript_id=?",
  ).run(row.event_id, row.id);
  db.prepare(
    "UPDATE concall_events SET current_transcript_id=?, updated_at=? WHERE id=?",
  ).run(row.id, now, row.event_id);
  db.prepare(
    "UPDATE transcripts SET stage_status='published', updated_at=? WHERE id=?",
  ).run(now, row.id);

  const type = previous ? "summary.updated" : "summary.created";
  const eventUuid = randomUUID();
  // SQLite allocates the monotonic ID. The placeholder cannot be seen outside this transaction.
  const eventId = db
    .prepare(
      "INSERT INTO outbox_events (event_uuid,type,summary_id,payload_json,created_at) VALUES (?,?,?,'{}',?)",
    )
    .run(eventUuid, type, id, now).lastInsertRowid;
  const payload = encodeJson(summaryEventSchema, {
    schema_version: 1,
    event_id: Number(eventId),
    event_uuid: eventUuid,
    type,
    emitted_at: now,
    data_mode: trusted.dataMode,
    data: {
      summary_id: id,
      company_id: row.company_id,
      concall_event_id: row.event_id,
      revision: row.version_number,
      is_mock: isMock,
      summary,
    },
  });
  db.prepare("UPDATE outbox_events SET payload_json=? WHERE id=?").run(
    payload,
    eventId,
  );
  return id;
}
