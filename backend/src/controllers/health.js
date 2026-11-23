import { PipelineError, publicError } from "../utils/errors.js";
import { systemClock, utcIso } from "../utils/clock.js";
import { isDatabaseReady } from "../models/queries.js";

/** Serve local health probes with a readiness check against SQLite. */
export function createHealthController({
  db,
  schemaVersion,
  mode,
  clock = systemClock,
  logger,
}) {
  const healthy = (status) => ({
    data: { status },
    meta: { mode, generated_at: utcIso(clock.now()) },
  });
  return {
    live(_req, res) {
      return res.json(healthy("ok"));
    },
    ready(_req, res) {
      try {
        if (isDatabaseReady(db, schemaVersion))
          return res.json(healthy("ready"));
      } catch {
        logger?.warn("database_readiness_failed", {
          stage: "storage",
          error_code: "DATABASE_UNAVAILABLE",
        });
      }
      return res
        .status(503)
        .json(publicError(new PipelineError("DATABASE_UNAVAILABLE")));
    },
  };
}
