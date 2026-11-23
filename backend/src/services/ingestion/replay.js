import { setTimeout as sleep } from "node:timers/promises";
import { activeCompanies, createDiscoveryRepository } from "./discovery.js";
import { replayFiling } from "../sources/fixture.js";
import { PipelineError } from "../../utils/errors.js";
import { utcIso, systemClock } from "../../utils/clock.js";

export function canReplay(config) {
  return (
    config.DATA_MODE === "fixture" &&
    config.AI_PROVIDER === "mock" &&
    config.ENABLE_DEMO_REPLAY &&
    config.FIXTURE_WATCH_ENABLED
  );
}

/** Queue a fixture replay while the server owns the ingestion lease. */
export function requestReplay(db, config, variant, clock = systemClock) {
  if (!canReplay(config)) throw new PipelineError("SOURCE_NOT_AUTHORIZED");
  if (!["replay", "correction"].includes(variant))
    throw new PipelineError("BAD_REQUEST");
  return db
    .transaction(() => {
      if (
        variant === "correction" &&
        !db
          .prepare(
            `SELECT 1 FROM summaries s JOIN outbox_events o ON o.summary_id=s.id
      JOIN transcripts t ON t.id=s.transcript_id JOIN document_sources ds ON ds.document_id=t.document_id
      JOIN source_filings f ON f.id=ds.filing_id WHERE f.source='FIXTURE' AND f.source_filing_id='synthetic-stage5-replay'
      AND s.published_at IS NOT NULL LIMIT 1`,
          )
          .get()
      )
        throw new PipelineError(
          "NOT_FOUND",
          "Publish the synthetic replay before requesting its correction",
        );
      const result = db
        .prepare(
          "INSERT INTO fixture_replays (variant,requested_at) VALUES (?,?) ON CONFLICT DO NOTHING",
        )
        .run(variant, utcIso(clock.now()));
      return {
        mode: "fixture",
        is_mock: true,
        variant,
        queued: Boolean(result.changes),
      };
    })
    .immediate();
}

/** Convert requested replays to ordinary, idempotent jobs through the fixture discovery repository. */
export async function runReplayQueue({
  db,
  config,
  sources,
  signal,
  clock,
  logger,
}) {
  if (!canReplay(config)) return;
  const store = createDiscoveryRepository(db);
  const consume = db.transaction(() => {
    const company = activeCompanies(db).find(
      ({ nseSymbol }) => nseSymbol === "TCS",
    );
    if (!company) return;
    const now = utcIso(clock.now());
    const requests = db
      .prepare(
        "SELECT variant FROM fixture_replays WHERE discovered_at IS NULL ORDER BY requested_at",
      )
      .all();
    for (const { variant } of requests) {
      store([replayFiling(variant, company)], company, sources.FIXTURE, now);
      db.prepare(
        "UPDATE fixture_replays SET discovered_at=? WHERE variant=?",
      ).run(now, variant);
    }
  }).immediate;
  while (!signal.aborted) {
    try {
      consume();
    } catch {
      logger?.warn("fixture_replay_queue_failed", { stage: "source" });
    }
    await sleep(300, undefined, { signal }).catch((error) => {
      if (!signal.aborted) throw error;
    });
  }
}
