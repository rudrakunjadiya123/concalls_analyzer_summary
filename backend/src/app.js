import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { healthRouter } from "./routes/health.js";
import { browseRouter } from "./routes/browse.js";
import {
  createHttpErrorHandler,
  notFound,
  setSecurityHeaders,
} from "./middlewares/http.js";

// Serve the sibling frontend workspace's production build.
const webRoot = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));

/** Expose the public read API and the built SPA, without exposing the private storage directory. */
export function createApp(options) {
  const app = express();
  app.disable("x-powered-by");
  app.use(setSecurityHeaders);
  app.use("/api/health", healthRouter(options));
  app.use("/api", express.json({ limit: "16kb" }), browseRouter(options));
  const entry = path.join(webRoot, "index.html");
  if (existsSync(entry)) {
    app.use(
      "/assets",
      express.static(path.join(webRoot, "assets"), {
        index: false,
        redirect: false,
        immutable: true,
        maxAge: "1y",
      }),
    );
    app.get(
      /^\/$|^\/(?:companies|summaries)\/[\da-f-]{36}\/?$/iu,
      (_req, res) => {
        res.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        res.sendFile(entry);
      },
    );
  }
  app.use(notFound);
  app.use(createHttpErrorHandler(options.logger));
  return app;
}
