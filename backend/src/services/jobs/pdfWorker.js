import { setTimeout as sleep } from "node:timers/promises";
import { PipelineError, publicError } from "../../utils/errors.js";
import { systemClock } from "../../utils/clock.js";
import { loadExtraction, materializeExtraction } from "../pdf/artifacts.js";
import { classifyTranscript } from "../transcript/classify.js";
import { extractMetadata } from "../transcript/period.js";

const unknownMetadata = (code) => ({
  call_date: null,
  quarter: null,
  period_end: null,
  company_confirmed: false,
  normalized_title: "",
  warnings: [code],
  metadata_provenance: [],
});

/** Run the private PDF pipeline in one lane, independently of downloads and source failures. */
export function createPdfWorker({
  repository,
  config,
  logger,
  clock = systemClock,
}) {
  async function process(job, signal) {
    const local = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, local.signal])
      : local.signal;
    const heartbeat = setInterval(
      () => {
        try {
          if (repository.renew(job)) return;
        } catch {
          /* Any uncertainty about lease ownership fences off subsequent writes. */
        }
        local.abort(new PipelineError("JOB_LEASE_LOST"));
      },
      Math.min(10_000, Math.max(100, (config.WORKER_LEASE_SECONDS * 1000) / 3)),
    ).unref();
    try {
      if (job.step === "extract") {
        const document = repository.document(job.entity_id);
        if (!document) throw new PipelineError("NOT_FOUND");
        const artifact =
          job.attempts > config.MAX_JOB_ATTEMPTS
            ? await loadExtraction(document, config, active)
            : await materializeExtraction(document, config, active);
        if (!artifact)
          throw new PipelineError(
            "JOB_LEASE_LOST",
            "An exhausted job has no completed artifact",
          );
        active.throwIfAborted();
        repository.finishExtract(job, artifact);
        logger?.info("pdf_extracted", {
          stage: "pdf",
          job_id: job.id,
          count: artifact.manifest.page_count,
        });
      } else {
        const context = repository.context(job.entity_id);
        if (context.extraction.status === "failed") {
          const code = context.extraction.error_code;
          repository.finishReview(
            job,
            context,
            null,
            {
              classification: "needs_document",
              role: "unknown",
              reason: code,
              confidence: "low",
              signals: {},
            },
            unknownMetadata(code),
          );
          return;
        }
        const artifact = await materializeExtraction(
          context.document,
          config,
          active,
        );
        const verdict = classifyTranscript(artifact.manifest, context.filing);
        const metadata = extractMetadata(
          artifact.manifest,
          context.filing,
          context.company,
          context.watchlist,
        );
        active.throwIfAborted();
        repository.finishReview(job, context, artifact, verdict, metadata);
        logger?.info("pdf_review_completed", { stage: "pdf", job_id: job.id });
      }
    } catch (error) {
      if (signal?.aborted) {
        repository.release(job);
        return;
      }
      if (local.signal.aborted) return;
      // A terminal out-of-budget recovery is recorded for the attached filings too.
      const safe = publicError(error).error;
      const retry = error.retryable || !(error instanceof PipelineError);
      const backoff = Math.max(
        100,
        Math.floor(
          Math.random() *
            Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 10)),
        ),
      );
      repository.fail(
        job,
        safe,
        retry ? new Date(clock.now().getTime() + backoff) : null,
      );
      logger?.warn("pdf_job_failed", {
        stage: "pdf",
        job_id: job.id,
        error_code: safe.code,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function drain(signal) {
    while (!signal?.aborted) {
      const job = repository.claim();
      if (!job) return;
      try {
        await process(job, signal);
      } catch (error) {
        if (error.code !== "JOB_LEASE_LOST") throw error;
      }
    }
  }

  return {
    drain,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await drain(signal);
        } catch (error) {
          logger?.error("pdf_worker_error", {
            stage: "pdf",
            error_code: publicError(error).error.code,
          });
        }
        await sleep(500, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
  };
}
