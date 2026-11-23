import { randomUUID } from "node:crypto";
import { PipelineError } from "../core/errors.js";
import { systemClock, utcIso } from "../core/clock.js";

/** Keep per-company checkpoints and independent, durable source-wide holds. */
export function createPollState(db, grants, clock = systemClock) {
  const stateRow =
    db.prepare(`SELECT h.*, (SELECT last_result FROM poll_cursors p
    WHERE p.source = h.source ORDER BY p.last_poll_completed_at DESC LIMIT 1) AS result
    FROM source_health h WHERE h.source = ?`);
  const cursorRow = db.prepare(
    "SELECT * FROM poll_cursors WHERE source = ? AND watchlist_partition = ?",
  );
  const seed =
    db.prepare(`INSERT INTO source_health (source, access_mode, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET access_mode = excluded.access_mode`);
  for (const [source, enabled] of Object.entries(grants)) {
    seed.run(
      source,
      !enabled
        ? "disabled_permission"
        : source === "FIXTURE"
          ? "fixture"
          : "authorized",
      utcIso(clock.now()),
    );
  }
  const startPoll = db.prepare(`INSERT INTO poll_cursors
    (id, source, watchlist_partition, last_poll_started_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, watchlist_partition) DO UPDATE SET
      last_poll_started_at = excluded.last_poll_started_at, updated_at = excluded.updated_at`);
  const endPoll =
    db.prepare(`UPDATE poll_cursors SET last_poll_completed_at = @now, updated_at = @now,
    last_result = @result, last_error_code = @code, next_allowed_poll_at = @next,
    last_successful_window_end = CASE WHEN @end IS NOT NULL AND
      (last_successful_window_end IS NULL OR @end > last_successful_window_end) THEN @end ELSE last_successful_window_end END
    WHERE source = @source AND watchlist_partition = @partition`);
  const endSource =
    db.prepare(`UPDATE source_health SET updated_at = @now, last_error_code = @code,
    last_success_at = CASE WHEN @result = 'success' THEN @now ELSE last_success_at END,
    last_failure_at = CASE WHEN @result IN ('error','incomplete','blocked') THEN @now ELSE last_failure_at END,
    latency_ms = @latency, documents_discovered = @count WHERE source = @source`);
  return {
    state: (source) => stateRow.get(source),
    cursor: (source, partition) => cursorRow.get(source, partition),
    check(source) {
      const state = stateRow.get(source);
      if (!grants[source])
        throw new PipelineError("SOURCE_NOT_AUTHORIZED", undefined, { source });
      if (state.blocked)
        throw new PipelineError("SOURCE_FORBIDDEN", undefined, { source });
      if (state.paused_until && state.paused_until > utcIso(clock.now())) {
        const error = new PipelineError("SOURCE_RATE_LIMITED", undefined, {
          source,
          retryable: true,
        });
        error.retryAfter = String(
          Math.ceil(
            (Date.parse(state.paused_until) - clock.now().getTime()) / 1000,
          ),
        );
        throw error;
      }
    },
    block(source, code) {
      const now = utcIso(clock.now());
      db.prepare(
        `UPDATE source_health SET blocked = 1, last_error_code = ?, last_failure_at = ?, updated_at = ?
        WHERE source = ?`,
      ).run(code, now, now, source);
    },
    pause(source, until) {
      const now = utcIso(clock.now());
      db.prepare(
        `UPDATE source_health SET paused_until = max(coalesce(paused_until, ''), ?),
        last_failure_at = ?, last_error_code = 'SOURCE_RATE_LIMITED', updated_at = ? WHERE source = ?`,
      ).run(utcIso(until), now, now, source);
    },
    start(source, partition, started) {
      const now = utcIso(started);
      startPoll.run(randomUUID(), source, partition, now, now);
    },
    finish({
      source,
      partition,
      result,
      code = null,
      end = null,
      next = null,
      started,
      count = null,
      recordCursor = true,
    }) {
      const now = clock.now();
      const params = {
        source,
        partition,
        result,
        code,
        count,
        now: utcIso(now),
        latency: Math.max(0, now - started),
        end: result === "success" && end ? utcIso(end) : null,
        next: next ? utcIso(next) : null,
      };
      if (recordCursor) endPoll.run(params);
      endSource.run(params);
    },
  };
}
