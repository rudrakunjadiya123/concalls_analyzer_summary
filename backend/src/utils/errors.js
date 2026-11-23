import { publicErrorSchema } from "@finosauras/shared";

// Public text is fixed per code. Internal causes and messages stay out of HTTP and logs.
const messages = Object.freeze({
  CONFIG_INVALID: "Invalid application configuration",
  SOURCE_NOT_AUTHORIZED: "Source access is not authorized",
  SOURCE_FORBIDDEN: "Source denied access",
  SOURCE_RATE_LIMITED: "Source rate limit reached",
  SOURCE_UNAVAILABLE: "Source is unavailable",
  SOURCE_SCHEMA_CHANGED: "Source response failed validation",
  SOURCE_PAGINATION_INCOMPLETE: "Source response is incomplete",
  UNVERIFIED_COMPANY: "Company identity could not be verified",
  COMPANY_IDENTITY_CONFLICT: "Company identifiers conflict",
  NO_TRANSCRIPT_ATTACHMENT: "No transcript attachment is available",
  DOWNLOAD_INVALID_TYPE: "Download is not an accepted file type",
  DOWNLOAD_TOO_LARGE: "Download exceeds the size limit",
  DOWNLOAD_TIMEOUT: "Download timed out",
  DOWNLOAD_UNSAFE_URL: "URL is outside the approved source policy",
  PDF_CORRUPT: "PDF could not be read",
  PDF_PASSWORD_PROTECTED: "PDF requires a password",
  PDF_TEXT_UNAVAILABLE: "PDF has no readable text",
  PDF_LAYOUT_LOW_CONFIDENCE: "PDF reading order is uncertain",
  PDF_TOO_MANY_PAGES: "PDF exceeds the page limit",
  PDF_RESOURCE_LIMIT: "PDF extraction exceeded a resource limit",
  PDF_EXTRACTION_TIMEOUT: "PDF extraction timed out",
  NOT_A_TRANSCRIPT: "Document is not a transcript",
  METADATA_AMBIGUOUS: "Transcript metadata requires review",
  AI_NO_KEY: "AI credentials are missing",
  AI_RATE_LIMITED: "AI rate limit reached",
  AI_TIMEOUT: "AI request timed out",
  AI_UNAVAILABLE: "AI provider is unavailable",
  AI_INSUFFICIENT_EVIDENCE:
    "Fewer than three supported takeaways were available",
  AI_STALE_REVISION:
    "The selected transcript revision is no longer publishable",
  AI_PROVIDER_RESTRICTED:
    "The configured AI provider cannot process this source",
  AI_SCHEMA_INVALID: "AI output failed schema validation",
  AI_EVIDENCE_UNSUPPORTED: "AI output lacks supporting evidence",
  AI_CONTEXT_LIMIT: "AI context limit reached",
  AI_BUDGET_EXCEEDED: "Document exceeds the AI input budget",
  DATABASE_BUSY: "Database is busy",
  DATABASE_UNAVAILABLE: "Database is unavailable",
  DATABASE_MIGRATION_FAILED: "Database migration failed",
  FILE_IO_ERROR: "Storage operation failed",
  UNSAFE_PATH: "Path is outside the approved storage policy",
  JOB_LEASE_LOST: "Job lease is no longer held",
  OUTBOX_PUBLISH_FAILURE: "Outbox publication failed",
  NOT_FOUND: "Resource not found",
  BAD_REQUEST: "Invalid request parameters",
  UNEXPECTED_ERROR: "An unexpected error occurred",
});

export const ERROR_CODES = Object.freeze(Object.keys(messages));

/** Pipeline failure with a stable code and structured internal context. */
export class PipelineError extends Error {
  constructor(
    code,
    message,
    { stage, source, retryable = false, statusCode, cause } = {},
  ) {
    const validCode = Object.hasOwn(messages, code) ? code : "UNEXPECTED_ERROR";
    super(message ?? messages[validCode], { cause });
    this.name = "PipelineError";
    this.code = validCode;
    this.stage = stage;
    this.source = source;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

/** Convert any exception to the public error contract without exposing diagnostics. */
export function publicError(error) {
  const code =
    error instanceof PipelineError && Object.hasOwn(messages, error.code)
      ? error.code
      : "UNEXPECTED_ERROR";
  return publicErrorSchema.parse({ error: { code, message: messages[code] } });
}
