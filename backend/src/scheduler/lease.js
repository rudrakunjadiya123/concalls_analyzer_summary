import { randomUUID } from "node:crypto";
import { PipelineError } from "../core/errors.js";
import { systemClock, utcIso } from "../core/clock.js";

/** Coordinate the singleton watcher/worker pair and one-shot administrative ingestion. */
export async function withPipelineLease(
  db,
  signal,
  operation,
  { clock = systemClock, seconds = 30 } = {},
) {
  const owner = randomUUID();
  const begin =
    db.prepare(`INSERT INTO scheduler_leases VALUES ('ingestion', @owner, @until)
    ON CONFLICT(name) DO UPDATE SET owner = @owner, expires_at = @until
    WHERE scheduler_leases.expires_at <= @now`);
  const renew = db.prepare(`UPDATE scheduler_leases SET expires_at = @until
    WHERE name = 'ingestion' AND owner = @owner AND expires_at > @now`);
  const current = () => {
    const now = clock.now();
    return {
      owner,
      now: utcIso(now),
      until: utcIso(new Date(now.getTime() + seconds * 1000)),
    };
  };
  signal?.throwIfAborted();
  if (!begin.run(current()).changes)
    throw new PipelineError(
      "DATABASE_BUSY",
      "The ingestion pipeline already owns this database",
    );
  const active = new AbortController();
  const guard = setInterval(
    () => {
      try {
        if (renew.run(current()).changes) return;
      } catch {
        /* Fail closed when ownership can no longer be confirmed. */
      }
      active.abort(new PipelineError("JOB_LEASE_LOST"));
    },
    (1000 * seconds) / 3,
  ).unref();
  try {
    const scoped = signal
      ? AbortSignal.any([signal, active.signal])
      : active.signal;
    const result = await operation(scoped);
    active.signal.throwIfAborted();
    return result;
  } catch (error) {
    // Workers may surface a generic abort after lease loss. Keep the original recovery reason.
    active.signal.throwIfAborted();
    throw error;
  } finally {
    clearInterval(guard);
    db.prepare(
      "DELETE FROM scheduler_leases WHERE name = 'ingestion' AND owner = ?",
    ).run(owner);
  }
}
