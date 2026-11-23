import { SOURCES } from "@finosauras/shared/constants";
import { ERROR_CODES } from "./errors.js";
import { systemClock, utcIso } from "./clock.js";

export const LOG_LEVELS = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);
const stages = new Set([
  "startup",
  "shutdown",
  "storage",
  "source",
  "download",
  "pdf",
  "ai",
  "publish",
  "http",
]);
const eventName = /^[a-z][a-z0-9_]{0,63}$/u;
const jobId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Create a JSON-line logger. Only supply fixed event names and typed diagnostic fields. */
export function createLogger({
  level = "info",
  clock = systemClock,
  write = console.log,
} = {}) {
  const threshold = LOG_LEVELS.indexOf(level);
  return Object.fromEntries(
    LOG_LEVELS.slice(0, -1).map((severity, index) => [
      severity,
      (event, fields = {}) => {
        if (index < threshold) return;
        // Request payloads, URLs, secrets, stack traces and exception messages are never serialized.
        const {
          stage,
          source,
          job_id,
          error_code,
          duration_ms,
          count,
          port,
          config_fields,
        } = fields;
        write(
          JSON.stringify({
            timestamp: utcIso(clock.now()),
            level: severity,
            event:
              typeof event === "string" && eventName.test(event)
                ? event
                : "diagnostic",
            stage: stages.has(stage) ? stage : undefined,
            source: SOURCES.includes(source) ? source : undefined,
            job_id: jobId.test(job_id) ? job_id : undefined,
            error_code: ERROR_CODES.includes(error_code)
              ? error_code
              : undefined,
            duration_ms: Number.isFinite(duration_ms) ? duration_ms : undefined,
            count: Number.isSafeInteger(count) ? count : undefined,
            port: Number.isInteger(port) ? port : undefined,
            config_fields: Array.isArray(config_fields)
              ? config_fields.filter((field) =>
                  /^[A-Z][A-Z0-9_]{0,63}$/u.test(field),
                )
              : undefined,
          }),
        );
      },
    ]),
  );
}
