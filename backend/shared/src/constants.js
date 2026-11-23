// Shared values keep runtime validation and later API/UI consumers aligned.
export const DATA_MODES = Object.freeze([
  "fixture",
  "authorized-direct",
  "licensed-feed",
]);
export const SOURCES = Object.freeze(["NSE", "BSE", "LICENSED", "FIXTURE"]);
export const AI_PROVIDERS = Object.freeze(["mock", "gemini", "extractive"]);
export const EXTRACTIVE_MODEL = "local-extractive-v1";
export const FILING_CLASSIFICATIONS = Object.freeze([
  "candidate",
  "excluded",
  "needs_document",
  "confirmed_transcript",
  "unsupported",
]);
export const JOB_STEPS = Object.freeze([
  "download",
  "extract",
  "classify",
  "summarize",
  "verify_publish",
]);
export const JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "retry_wait",
  "completed",
  "dead",
]);
export const TRANSCRIPT_STAGES = Object.freeze([
  "downloaded",
  "extracted",
  "classified",
  "facts_extracted",
  "validated",
  "published",
  "needs_review",
  "failed",
]);
export const POLL_RESULTS = Object.freeze([
  "success",
  "incomplete",
  "blocked",
  "error",
  "disabled",
]);
export const ACCESS_MODES = Object.freeze([
  "authorized",
  "fixture",
  "disabled_permission",
]);
export const EVENT_TYPES = Object.freeze([
  "summary.created",
  "summary.updated",
]);

/** Return whether a job is in a terminal state. */
export function isTerminalJobStatus(status) {
  return status === "completed" || status === "dead";
}
