import { Router } from "express";
import { createBrowseController } from "../controllers/browse.js";

export function browseRouter(options) {
  const router = Router();
  const controller = createBrowseController(options);
  router.get("/status", controller.status);
  router.get("/watchlist", controller.watchlist);
  router.get("/companies", controller.companies);
  router.get("/companies/:id", controller.company);
  router.get("/companies/:id/summaries", controller.companySummaries);
  router.get("/summaries", controller.summaries);
  router.get("/summaries/:id", controller.summary);
  router.get("/summaries/:id/markdown", controller.markdown);
  router.get("/summaries/:id/evidence", controller.evidence);
  router.get("/events/latest", controller.latestEvent);
  router.get("/events", controller.events);
  return router;
}
