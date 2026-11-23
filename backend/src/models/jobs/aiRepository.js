import { randomUUID } from "node:crypto";
import { decodeJson, encodeJson } from "../queries.js";
import { PipelineError } from "../../utils/errors.js";
import { systemClock, utcIso } from "../../utils/clock.js";
import {
  GEMINI_PROMPT_VERSION,
  PROMPT_VERSION,
} from "../../services/ai/prompts.js";
import { draftSchema, mappedSchema } from "../../services/ai/contracts.js";
import { summaryContext } from "../../services/summary/context.js";
import { publishVerified } from "../../services/summary/publish.js";

const stale = () => new PipelineError("AI_STALE_REVISION");
const lost = () => new PipelineError("JOB_LEASE_LOST");

/** Durable provider work and publication share the existing job ledger. */
export function createAiRepository(db, config, provider, clock = systemClock) {
  const promptVersion =
    provider.id === "gemini" ? GEMINI_PROMPT_VERSION : PROMPT_VERSION;
  const now = () => utcIso(clock.now());
  const until = () =>
    utcIso(
      new Date(clock.now().getTime() + config.WORKER_LEASE_SECONDS * 1000),
    );
  const runById = db.prepare("SELECT * FROM ai_runs WHERE id=?");
  const owner = db.prepare(
    `SELECT 1 FROM processing_jobs WHERE id=? AND step=? AND status='running' AND lease_owner=? AND lease_expires_at>?`,
  );
  const guarded = (job) => {
    if (!owner.get(job.id, job.step, job.lease_owner, now())) throw lost();
  };
  const addJob = db.prepare(`INSERT INTO processing_jobs
    (id,job_key,kind,entity_id,step,status,attempts,next_run_at,created_at,updated_at)
    VALUES (?,?,'ai_run',?,?,'queued',0,?,?,?) ON CONFLICT(job_key) DO NOTHING`);
  const enqueue = (run, step) =>
    addJob.run(
      randomUUID(),
      `${step}:${run.id}`,
      run.id,
      step,
      now(),
      now(),
      now(),
    );
  const settle = (job, status, error = null, next = now(), release = 0) =>
    db
      .prepare(
        `UPDATE processing_jobs
    SET status=?,last_error_code=?,last_error_message=?,next_run_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL,
      attempts=attempts-? WHERE id=? AND lease_owner=?`,
      )
      .run(
        status,
        error?.code ?? null,
        error?.message ?? null,
        next,
        now(),
        release,
        job.id,
        job.lease_owner,
      );

  return {
    enqueueRefresh: db.transaction((summaryId) => {
      if (provider.id !== "gemini" || !provider.status().configured)
        throw new PipelineError("AI_PROVIDER_RESTRICTED");
      const summary = db
        .prepare(
          "SELECT transcript_id, event_id, prompt_version, is_current FROM summaries WHERE id=?",
        )
        .get(summaryId);
      if (!summary) throw new PipelineError("NOT_FOUND");
      const { transcript_id: transcriptId } = summary;
      summaryContext(db, transcriptId, config, provider);
      const current = db
        .prepare(
          "SELECT transcript_id, prompt_version FROM summaries WHERE event_id=? AND is_current=1",
        )
        .get(summary.event_id);
      if (current?.transcript_id !== transcriptId) throw stale();
      if (current.prompt_version === promptVersion) return transcriptId;
      if (!summary.is_current) throw stale();
      // The refresh uses the same durable job key and consent checks as normal publication.
      const run = db
        .prepare(
          `INSERT INTO ai_runs (id,transcript_id,prompt_version,model_id,ai_provider,created_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`,
        )
        .get(
          randomUUID(),
          transcriptId,
          promptVersion,
          provider.model,
          provider.id,
          now(),
        );
      if (run) enqueue(run, "summarize");
      return transcriptId;
    }).immediate,
    refreshResult(transcriptId) {
      const summary = db
        .prepare(
          "SELECT id FROM summaries WHERE transcript_id=? AND prompt_version=? AND is_current=1",
        )
        .get(transcriptId, promptVersion);
      if (summary) return { summary_id: summary.id, status: "published" };
      return db
        .prepare(
          `SELECT j.status, j.last_error_code, j.next_run_at FROM ai_runs a
         JOIN processing_jobs j ON j.entity_id=a.id
         WHERE a.transcript_id=? AND a.prompt_version=? AND a.model_id=? AND a.ai_provider=?
         ORDER BY CASE j.step WHEN 'verify_publish' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(transcriptId, promptVersion, provider.model, provider.id);
    },
    enqueueEligible: db.transaction(() => {
      if (
        !provider.status().configured ||
        (provider.isMock && config.DATA_MODE !== "fixture")
      )
        return;
      const rows = db
        .prepare(
          `SELECT t.id FROM transcripts t JOIN event_transcripts v ON v.transcript_id=t.id
        WHERE t.stage_status IN ('classified','needs_review','facts_extracted','validated')
          AND v.revision_kind IN ('original','correction')
          AND NOT EXISTS (SELECT 1 FROM ai_runs a WHERE a.transcript_id=t.id AND a.prompt_version=?
            AND a.model_id=? AND a.ai_provider=?)
          AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.transcript_id=t.id AND s.published_at IS NOT NULL)
          AND v.version_number=(SELECT max(v2.version_number) FROM event_transcripts v2 WHERE v2.event_id=v.event_id
            AND v2.revision_kind IN ('original','correction'))
        ORDER BY t.created_at,t.id`,
        )
        .all(promptVersion, provider.model, provider.id);
      for (const { id } of rows) {
        try {
          summaryContext(db, id, config, provider);
        } catch (error) {
          if (
            [
              "AI_PROVIDER_RESTRICTED",
              "AI_STALE_REVISION",
              "NOT_FOUND",
            ].includes(error.code)
          )
            continue;
          throw error;
        }
        const run = { id: randomUUID() };
        db.prepare(
          `INSERT INTO ai_runs (id,transcript_id,prompt_version,model_id,ai_provider,created_at) VALUES (?,?,?,?,?,?)`,
        ).run(run.id, id, promptVersion, provider.model, provider.id, now());
        enqueue(run, "summarize");
      }
    }).immediate,
    claim: db.transaction((transcriptId = null) => {
      const instant = now();
      const limit = config.MAX_JOB_ATTEMPTS;
      const dead = db
        .prepare(
          `UPDATE processing_jobs
        SET status=CASE WHEN attempts>=@limit THEN 'dead' ELSE 'retry_wait' END,
        lease_owner=NULL, lease_expires_at=NULL, updated_at=@now, next_run_at=@now,
        last_error_code='JOB_LEASE_LOST',last_error_message='Expired AI job lease recovered'
        WHERE step IN ('summarize','verify_publish') AND status='running' AND lease_expires_at<=@now
        RETURNING entity_id,status`,
        )
        .all({ limit, now: instant });
      for (const row of dead)
        if (row.status === "dead") {
          const run = runById.get(row.entity_id);
          db.prepare(
            "UPDATE transcripts SET stage_status='needs_review',updated_at=? WHERE id=? AND stage_status<>'published'",
          ).run(instant, run.transcript_id);
        }
      const job = db
        .prepare(
          `UPDATE processing_jobs SET status='running',attempts=attempts+1,lease_owner=@owner,
        lease_expires_at=@until,updated_at=@now WHERE id=(
          SELECT j.id FROM processing_jobs j JOIN ai_runs a ON a.id=j.entity_id
          WHERE j.step IN ('summarize','verify_publish') AND j.status IN ('queued','retry_wait') AND j.next_run_at<=@now
            AND j.attempts<@limit AND a.ai_provider=@provider AND a.model_id=@model AND a.prompt_version=@version
            AND (@transcriptId IS NULL OR a.transcript_id=@transcriptId)
            AND (j.step='verify_publish' OR NOT EXISTS (
              SELECT 1 FROM ai_provider_holds h WHERE h.ai_provider=a.ai_provider AND h.model_id=a.model_id AND h.resume_at>@now))
          ORDER BY CASE j.step WHEN 'verify_publish' THEN 0 ELSE 1 END,j.next_run_at,j.id LIMIT 1
        ) RETURNING *`,
        )
        .get({
          limit,
          owner: randomUUID(),
          until: until(),
          now: instant,
          provider: provider.id,
          model: provider.model,
          version: promptVersion,
          transcriptId,
        });
      return job ? { ...job, run: runById.get(job.entity_id) } : null;
    }).immediate,
    context: (job) =>
      summaryContext(db, job.run.transcript_id, config, provider),
    renew(job) {
      return Boolean(
        db
          .prepare(
            `UPDATE processing_jobs SET lease_expires_at=?,updated_at=?
        WHERE id=? AND step=? AND status='running' AND lease_owner=? AND lease_expires_at>?`,
          )
          .run(until(), now(), job.id, job.step, job.lease_owner, now())
          .changes,
      );
    },
    prepare: db.transaction((job, context, fingerprint) => {
      guarded(job);
      const latest = db
        .prepare(
          `SELECT max(version_number) AS version FROM event_transcripts WHERE event_id=?
        AND revision_kind IN ('original','correction')`,
        )
        .get(context.row.event_id);
      if (context.row.version_number !== latest.version) throw stale();
      const run = runById.get(job.entity_id);
      if (run.input_fingerprint && run.input_fingerprint !== fingerprint)
        throw stale();
      db.prepare(
        "UPDATE ai_runs SET input_fingerprint=? WHERE id=? AND input_fingerprint IS NULL",
      ).run(fingerprint, run.id);
    }).immediate,
    repair: db.transaction((job, kind) => {
      guarded(job);
      // A documented repair budget survives process retries and restarts.
      const column =
        kind === "format" ? "format_repair_used" : "synthesis_repair_used";
      return Boolean(
        db
          .prepare(`UPDATE ai_runs SET ${column}=1 WHERE id=? AND ${column}=0`)
          .run(job.entity_id).changes,
      );
    }).immediate,
    reserve: db.transaction((job, count) => {
      guarded(job);
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        !db
          .prepare(
            `UPDATE ai_runs
        SET estimated_input_tokens=estimated_input_tokens+? WHERE id=? AND estimated_input_tokens+?<=?`,
          )
          .run(count, job.entity_id, count, config.MAX_AI_INPUT_TOKENS_PER_DOC)
          .changes
      )
        throw new PipelineError("AI_BUDGET_EXCEEDED");
    }).immediate,
    report(job, estimated, usage) {
      const spent = db
        .transaction(() => {
          guarded(job);
          // Reserve before requesting, then account for a larger provider-reported prompt after the response.
          db.prepare(
            `UPDATE ai_runs SET reported_input_tokens=reported_input_tokens+?,
          reported_output_tokens=reported_output_tokens+?, estimated_input_tokens=estimated_input_tokens+? WHERE id=?`,
          ).run(
            usage.input,
            usage.output,
            Math.max(0, usage.input - estimated),
            job.entity_id,
          );
          return runById.get(job.entity_id).estimated_input_tokens;
        })
        .immediate();
      if (spent > config.MAX_AI_INPUT_TOKENS_PER_DOC)
        throw new PipelineError("AI_BUDGET_EXCEEDED");
    },
    cached(job, hash) {
      const row = db
        .prepare(
          "SELECT facts_json FROM ai_chunk_cache WHERE run_id=? AND chunk_hash=?",
        )
        .get(job.entity_id, hash);
      return row ? decodeJson(mappedSchema, row.facts_json) : null;
    },
    cache: db.transaction((job, hash, facts) => {
      guarded(job);
      db.prepare(
        "INSERT INTO ai_chunk_cache VALUES (?,?,?,?) ON CONFLICT(run_id,chunk_hash) DO NOTHING",
      ).run(job.entity_id, hash, encodeJson(mappedSchema, facts), now());
    }).immediate,
    saveDraft: db.transaction((job, draft) => {
      guarded(job);
      const run = runById.get(job.entity_id);
      db.prepare("UPDATE ai_runs SET draft_json=? WHERE id=?").run(
        encodeJson(draftSchema, draft),
        run.id,
      );
      db.prepare(
        "UPDATE transcripts SET stage_status='facts_extracted',updated_at=? WHERE id=? AND stage_status<>'published'",
      ).run(now(), run.transcript_id);
      enqueue(run, "verify_publish");
      settle(job, "completed");
    }).immediate,
    publish: db.transaction((job, context, verified) => {
      guarded(job);
      const run = runById.get(job.entity_id);
      const id = publishVerified(db, { run, context, verified, now: now() });
      settle(job, "completed");
      return id;
    }).immediate,
    fail: db.transaction((job, error, retryAt) => {
      guarded(job);
      if (error.code === "AI_RATE_LIMITED" && retryAt)
        db.prepare(
          `INSERT INTO ai_provider_holds VALUES (?,?,?)
        ON CONFLICT(ai_provider,model_id) DO UPDATE SET resume_at=max(resume_at,excluded.resume_at)`,
        ).run(provider.id, provider.model, utcIso(retryAt));
      const retry = retryAt && job.attempts < config.MAX_JOB_ATTEMPTS;
      if (
        !retry &&
        !["AI_PROVIDER_RESTRICTED", "AI_STALE_REVISION"].includes(error.code)
      ) {
        db.prepare(
          "UPDATE transcripts SET stage_status='needs_review',updated_at=? WHERE id=? AND stage_status<>'published'",
        ).run(now(), job.run.transcript_id);
      }
      settle(
        job,
        retry ? "retry_wait" : "dead",
        error,
        retry ? utcIso(retryAt) : now(),
      );
    }).immediate,
    release: db.transaction((job) => {
      guarded(job);
      settle(job, "queued", null, now(), 1);
    }).immediate,
    counts() {
      return db
        .prepare(
          `SELECT j.step,j.status,count(*) AS count FROM processing_jobs j
        JOIN ai_runs a ON a.id=j.entity_id WHERE j.step IN ('summarize','verify_publish') AND a.ai_provider=?
        AND a.model_id=? AND a.prompt_version=? GROUP BY j.step,j.status`,
        )
        .all(provider.id, provider.model, promptVersion);
    },
    pausedUntil: () =>
      db
        .prepare(
          "SELECT resume_at FROM ai_provider_holds WHERE ai_provider=? AND model_id=? AND resume_at>?",
        )
        .get(provider.id, provider.model, now())?.resume_at ?? null,
  };
}
