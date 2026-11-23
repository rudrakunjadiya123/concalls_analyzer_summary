import { PipelineError, publicError } from "../utils/errors.js";

export function setSecurityHeaders(_req, res, next) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  next();
}

export function requireNoQuery(req, res, next) {
  if (Object.keys(req.query).length)
    return res.status(400).json(publicError(new PipelineError("BAD_REQUEST")));
  next();
}

export function notFound(_req, res) {
  return res.status(404).json(publicError(new PipelineError("NOT_FOUND")));
}

export function createHttpErrorHandler(logger) {
  return (error, _req, res, next) => {
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
    logger?.error("http_error", {
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
  };
}
