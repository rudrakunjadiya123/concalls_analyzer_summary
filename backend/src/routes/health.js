import { Router } from "express";
import { createHealthController } from "../controllers/health.js";
import { requireNoQuery } from "../middlewares/http.js";

export function healthRouter(options) {
  const router = Router();
  const controller = createHealthController(options);
  router.use(["/live", "/ready"], requireNoQuery);
  router.get("/live", controller.live);
  router.get("/ready", controller.ready);
  return router;
}
