import Database from "better-sqlite3";
import { PipelineError } from "../core/errors.js";
import { prepareStorage } from "../core/storage.js";

/** Open the on-disk database with the same SQLite settings for CLI and API users. */
export function openDatabase(config) {
  prepareStorage(config);
  let db;
  try {
    db = new Database(config.DATABASE_PATH, { timeout: 5000 });
    db.pragma("foreign_keys = ON");
    // Require WAL on the configured local disk so readiness reflects the intended setup.
    if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
      throw new PipelineError("DATABASE_UNAVAILABLE");
    }
    return db;
  } catch (cause) {
    db?.close();
    const busy = cause.code?.startsWith("SQLITE_BUSY");
    throw new PipelineError(
      busy ? "DATABASE_BUSY" : "DATABASE_UNAVAILABLE",
      undefined,
      {
        stage: "storage",
        cause,
        retryable: Boolean(busy),
      },
    );
  }
}
