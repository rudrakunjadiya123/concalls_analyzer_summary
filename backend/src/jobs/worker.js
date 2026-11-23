import { lstat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { retryAfterMs } from "../core/retry.js";
import { safePath } from "../core/storage.js";
import { PipelineError, publicError } from "../core/errors.js";
import { systemClock } from "../core/clock.js";
import { downloadDocument } from "../ingestion/download.js";

/** Create a download-only worker with lease renewal and per-URL single flight. */
export function createDownloadWorker({
  jobs,
  sources,
  config,
  logger,
  clock = systemClock,
  random = Math.random,
}) {
  const inFlight = new Map();
  const enabled = Object.values(sources).filter(({ enabled }) => enabled);

  async function obtain(job, controller) {
    const { url, source, cache_key: key } = job.target;
    const adapter = sources[source];
    adapter.guard();
    if (!adapter.allowedAttachment(url))
      throw new PipelineError("DOWNLOAD_UNSAFE_URL");
    const existing = jobs.cached(key);
    if (existing) {
      const file = await lstat(
        safePath(config.DATA_DIR, existing.storage_relative_path),
      ).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (
        file?.isFile() &&
        file.nlink === 1 &&
        file.size === existing.size_bytes
      )
        return { documentId: existing.id };
    }
    // A recovery attempt beyond the transfer budget can only finalize an existing validated file.
    if (job.attempts > config.MAX_JOB_ATTEMPTS)
      throw new PipelineError("FILE_IO_ERROR");
    const pending = inFlight.get(key);
    if (pending) {
      try {
        return await pending.result;
      } catch (error) {
        // A denial from one source cannot cause a valid reference from another source to fail.
        if (pending.source === source) throw error;
      }
    }
    controller.signal.throwIfAborted();
    const result = downloadDocument(
      adapter,
      url,
      config,
      controller.signal,
    ).then((artifact) => {
      controller.signal.throwIfAborted();
      return { documentId: jobs.recordArtifact(job, artifact) };
    });
    inFlight.set(key, { source, result });
    return result;
  }

  async function process(job, signal) {
    const local = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, local.signal])
      : local.signal;
    const heartbeat = setInterval(
      () => {
        try {
          if (jobs.renew(job)) return;
        } catch {
          // A stale owner must stop before committing results, even after a storage error.
        }
        local.abort(new PipelineError("JOB_LEASE_LOST"));
      },
      Math.max(
        100,
        Math.min(10_000, Math.floor((config.WORKER_LEASE_SECONDS * 1000) / 3)),
      ),
    ).unref();
    try {
      if (!job.target) throw new PipelineError("NOT_FOUND");
      const artifact = await obtain(job, { signal: combined });
      combined.throwIfAborted();
      jobs.finish(job, artifact);
      logger?.info("download_completed", {
        stage: "download",
        source: job.target.source,
        job_id: job.id,
      });
    } catch (error) {
      if (signal?.aborted) {
        jobs.release(job);
        return;
      }
      if (local.signal.aborted || error.code === "JOB_LEASE_LOST") return;
      const safe = publicError(error).error;
      const now = clock.now();
      const backoff = Math.floor(
        random() *
          Math.min(300_000, 3000 * 2 ** (Math.min(20, job.attempts) - 1)),
      );
      const delay = Math.max(
        100,
        Math.min(86_400_000, retryAfterMs(error.retryAfter, now) ?? backoff),
      );
      const retry = error.retryable || !(error instanceof PipelineError);
      jobs.fail(job, safe, retry ? new Date(now.getTime() + delay) : null);
      logger?.warn("download_failed", {
        stage: "download",
        source: job.target?.source,
        job_id: job.id,
        error_code: safe.code,
      });
    } finally {
      if (
        job.target &&
        inFlight.get(job.target.cache_key)?.source === job.target.source
      )
        inFlight.delete(job.target.cache_key);
      clearInterval(heartbeat);
    }
  }

  async function drain(signal) {
    // A lane claims new work only after completing its previous job.
    const lanes = Array.from(
      { length: config.MAX_CONCURRENT_DOWNLOADS },
      async () => {
        while (!signal?.aborted) {
          const permitted = enabled
            .filter((source) => {
              try {
                source.guard();
                return true;
              } catch (error) {
                if (
                  [
                    "SOURCE_RATE_LIMITED",
                    "SOURCE_FORBIDDEN",
                    "SOURCE_NOT_AUTHORIZED",
                  ].includes(error.code)
                )
                  return false;
                throw error;
              }
            })
            .map(({ source }) => source);
          if (!permitted.length) return;
          const job = jobs.claim(permitted);
          if (!job) return;
          try {
            await process(job, signal);
          } catch (error) {
            if (error.code !== "JOB_LEASE_LOST") throw error;
          }
        }
      },
    );
    // Wait for other lanes to release their leases even if one storage operation fails.
    const results = await Promise.allSettled(lanes);
    const failed = results.find(({ status }) => status === "rejected");
    if (failed) throw failed.reason;
  }

  return {
    drain,
    async run(signal) {
      while (!signal.aborted) {
        try {
          await drain(signal);
        } catch (error) {
          logger?.error("download_worker_error", {
            stage: "download",
            error_code: publicError(error).error.code,
          });
        }
        await sleep(1000, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
  };
}
