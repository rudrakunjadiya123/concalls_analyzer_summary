import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineError, publicError } from "./core/errors.js";
import { healthRouter } from "./routes/health.js";
import { browseRouter } from "./routes/browse.js";

// Serve the sibling frontend workspace's production build.
const webRoot = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));

/** Expose the public read API and the built SPA, without exposing the private storage directory. */
export function createApp(options) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    next();
  });
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
  app.use((_req, res) =>
    res.status(404).json(publicError(new PipelineError("NOT_FOUND"))),
  );
  app.use((error, _req, res, next) => {
    // Express owns error handling once a response has started streaming.
    if (res.headersSent) return next(error);
    const input =
      error instanceof URIError ||
      error.type === "entity.parse.failed" ||
      error.type === "entity.too.large";
    const busy = error.code?.startsWith("SQLITE_BUSY");
    const envelope = publicError(
      input
        ? new PipelineError("BAD_REQUEST")
        : busy
          ? new PipelineError("DATABASE_BUSY")
          : error,
    );
    options.logger?.error("http_error", {
      stage: "http",
      error_code: envelope.error.code,
    });
    res
      .status(
        input
          ? (error.status ?? 400)
          : busy
            ? 503
            : error instanceof PipelineError
              ? (error.statusCode ?? 500)
              : 500,
      )
      .json(envelope);
  });
  return app;
}
