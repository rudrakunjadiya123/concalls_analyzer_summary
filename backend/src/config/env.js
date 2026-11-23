import path from "node:path";
import { z } from "zod";
import { AI_PROVIDERS, DATA_MODES } from "@finosauras/shared/constants";
import { PipelineError } from "../core/errors.js";
import { LOG_LEVELS } from "../core/logger.js";
import { parseSourceUrl } from "../core/security.js";
import { resolveDatabasePath } from "../core/storage.js";

const flag = (fallback) =>
  z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(fallback);
const integer = (fallback, min = 1, max = 2_147_483_647) =>
  z
    .string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.int().min(min).max(max))
    .default(fallback);
const blank = z.string().trim().default("");
const endpoint = blank.refine((value) => {
  if (!value) return true;
  try {
    parseSourceUrl(value);
    return true;
  } catch {
    return false;
  }
}, "Expected configured HTTPS URL");
const attachmentHosts = blank.refine(
  (value) =>
    !value ||
    value.split(",").every((host) => {
      const name = host.trim();
      try {
        return parseSourceUrl(`https://${name}`).hostname === name;
      } catch {
        return false;
      }
    }),
  "Expected comma-separated lowercase HTTPS hostnames",
);

// Parse string literals explicitly. JavaScript boolean coercion would treat "false" as true.
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: integer(3000, 1, 65535),
  HOST: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9.:-]+$/u)
    .default("0.0.0.0"),
  DATA_DIR: z.string().trim().min(1).default("./data"),
  DATABASE_PATH: blank,
  DATA_MODE: z.enum(DATA_MODES).default("fixture"),
  LIVE_POLLING_ENABLED: flag(false),
  LIVE_MAX_DOCUMENTS_PER_POLL: integer(0, 0),
  FIXTURE_WATCH_ENABLED: flag(true),
  NSE_ACCESS_AUTHORIZED: flag(false),
  BSE_ACCESS_AUTHORIZED: flag(false),
  NSE_FEED_URL: endpoint,
  BSE_FEED_URL: endpoint,
  NSE_ATTACHMENT_HOSTS: attachmentHosts,
  BSE_ATTACHMENT_HOSTS: attachmentHosts,
  BSE_ATTACHMENT_BASE_URL: endpoint,
  LICENSED_FEED_URL: endpoint,
  LICENSED_ATTACHMENT_HOSTS: attachmentHosts,
  LICENSED_FEED_TOKEN: blank,
  LICENSED_FEED_AUTHORIZED: flag(false),
  LICENSED_FEED_REQUIRES_TOKEN: flag(false),
  POLL_INTERVAL_SECONDS: integer(300, 1, 2_147_483),
  POLL_OVERLAP_HOURS: integer(48),
  INITIAL_BACKFILL_DAYS: integer(180),
  SOURCE_MIN_GAP_MS: integer(3000, 0),
  SOURCE_TIMEOUT_MS: integer(15000),
  DOWNLOAD_TIMEOUT_MS: integer(30000),
  MAX_DOWNLOAD_BYTES: integer(25_000_000),
  MAX_PDF_PAGES: integer(150),
  MAX_SOURCE_PAGES: integer(200),
  MAX_CONCURRENT_DOWNLOADS: integer(2, 1, 16),
  MAX_CONCURRENT_LLM_CALLS: integer(1, 1, 8),
  MAX_JOB_ATTEMPTS: integer(4),
  WORKER_LEASE_SECONDS: integer(300),
  AI_PROVIDER: z.enum(AI_PROVIDERS).default("mock"),
  GEMINI_API_KEY: blank,
  // Blank model settings in a copied environment use the same default as unset ones.
  GEMINI_MODEL: blank.transform((value) => value || "gemini-3.5-flash-lite"),
  GEMINI_FACT_MODE: z.enum(["model", "extractive"]).default("model"),
  AI_CHUNK_TARGET_TOKENS: integer(6000),
  AI_CHUNK_OVERLAP_TOKENS: integer(300, 0),
  MAX_AI_INPUT_TOKENS_PER_DOC: integer(160000),
  AI_TEMPERATURE: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/u)
    .transform(Number)
    .pipe(z.number().min(0).max(2))
    .default(0),
  ENABLE_OCR: flag(false),
  ENABLE_DEMO_REPLAY: flag(true),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  WS_MAX_CLIENTS: integer(100),
  WS_MAX_BUFFERED_BYTES: integer(1_048_576),
});

/** Return per-source grants from the validated profile. This function performs no I/O. */
export function sourceGrants(config) {
  const direct =
    config.LIVE_POLLING_ENABLED && config.DATA_MODE === "authorized-direct";
  const licensed =
    config.LIVE_POLLING_ENABLED && config.DATA_MODE === "licensed-feed";
  return Object.freeze({
    FIXTURE: config.DATA_MODE === "fixture",
    NSE: Boolean(direct && config.NSE_ACCESS_AUTHORIZED && config.NSE_FEED_URL),
    BSE: Boolean(direct && config.BSE_ACCESS_AUTHORIZED && config.BSE_FEED_URL),
    LICENSED: Boolean(
      licensed &&
      config.LICENSED_FEED_AUTHORIZED &&
      config.LICENSED_FEED_URL &&
      (!config.LICENSED_FEED_REQUIRES_TOKEN || config.LICENSED_FEED_TOKEN),
    ),
  });
}

export class ConfigError extends PipelineError {
  constructor(fields) {
    super("CONFIG_INVALID", undefined, { stage: "startup" });
    // Field names help operators diagnose config without logging rejected inputs or secrets.
    this.fields = [...new Set(fields)].sort();
  }
}

/** Parse the environment and validate profile, authorization and storage invariants. */
export function readConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new ConfigError(parsed.error.issues.map((issue) => issue.path[0]));
  const config = parsed.data;
  const invalid = [];
  const grants = sourceGrants(config);
  if (
    config.LIVE_POLLING_ENABLED &&
    config.DATA_MODE === "authorized-direct" &&
    !grants.NSE &&
    !grants.BSE
  ) {
    invalid.push(
      "NSE_ACCESS_AUTHORIZED",
      "NSE_FEED_URL",
      "BSE_ACCESS_AUTHORIZED",
      "BSE_FEED_URL",
    );
  }
  if (config.LIVE_POLLING_ENABLED && config.DATA_MODE === "licensed-feed") {
    if (!config.LICENSED_FEED_AUTHORIZED)
      invalid.push("LICENSED_FEED_AUTHORIZED");
    if (!config.LICENSED_FEED_URL) invalid.push("LICENSED_FEED_URL");
    if (config.LICENSED_FEED_REQUIRES_TOKEN && !config.LICENSED_FEED_TOKEN)
      invalid.push("LICENSED_FEED_TOKEN");
  }
  if (config.AI_PROVIDER === "gemini" && !config.GEMINI_API_KEY)
    invalid.push("GEMINI_API_KEY");
  if (config.AI_CHUNK_OVERLAP_TOKENS >= config.AI_CHUNK_TARGET_TOKENS)
    invalid.push("AI_CHUNK_OVERLAP_TOKENS");
  if (config.AI_CHUNK_TARGET_TOKENS > config.MAX_AI_INPUT_TOKENS_PER_DOC)
    invalid.push("MAX_AI_INPUT_TOKENS_PER_DOC");
  if (
    /\p{Cc}/u.test(config.DATA_DIR) ||
    config.DATA_DIR.split(/[/\\]/u).includes("..")
  )
    invalid.push("DATA_DIR");
  if (invalid.length) throw new ConfigError(invalid);

  config.DATA_DIR = path.resolve(cwd, config.DATA_DIR);
  if (config.DATA_DIR === path.parse(config.DATA_DIR).root)
    throw new ConfigError(["DATA_DIR"]);
  try {
    config.DATABASE_PATH = resolveDatabasePath(
      config.DATA_DIR,
      config.DATABASE_PATH,
      cwd,
    );
  } catch {
    throw new ConfigError(["DATABASE_PATH"]);
  }
  return Object.freeze(config);
}
