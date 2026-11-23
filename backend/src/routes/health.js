import { Router } from "express";
import { PipelineError, publicError } from "../core/errors.js";
import { systemClock, utcIso } from "../core/clock.js";
import { isDatabaseReady } from "../db/queries.js";

/** Create local health probes. Readiness checks SQLite without contacting an upstream. */
export function healthRouter({
  db,
  schemaVersion,
  mode,
  clock = systemClock,
  logger,
}) {
  const router = Router();
  const healthy = (status) => ({
    data: { status },
    meta: { mode, generated_at: utcIso(clock.now()) },
  });
  router.use(["/live", "/ready"], (req, res, next) => {
    if (Object.keys(req.query).length)
      return res
        .status(400)
        .json(publicError(new PipelineError("BAD_REQUEST")));
    next();
  });

  router.get("/live", (_req, res) => res.json(healthy("ok")));
  router.get("/ready", (_req, res) => {
    try {
      if (isDatabaseReady(db, schemaVersion)) return res.json(healthy("ready"));
    } catch {
      logger?.warn("database_readiness_failed", {
        stage: "storage",
        error_code: "DATABASE_UNAVAILABLE",
      });
    }
    return res
      .status(503)
      .json(publicError(new PipelineError("DATABASE_UNAVAILABLE")));
  });
  return router;
}
