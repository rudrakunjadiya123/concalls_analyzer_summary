import { readdirSync, readFileSync } from "node:fs";
import { systemClock, utcIso } from "../utils/clock.js";
import { PipelineError } from "../utils/errors.js";

const migrationsDir = new URL("./migrations/", import.meta.url);
const ledgerSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at TEXT NOT NULL
) STRICT`;

function migrationFiles(directory) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const entries = files.map((name, index) => {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/u.exec(name);
    const version = match ? Number(match[1]) : 0;
    if (version !== index + 1)
      throw new Error("Migrations must be sequential and uniquely numbered");
    return { version, name };
  });
  if (!entries.length) throw new Error("No migration files were found");
  return entries;
}

/** Apply each forward-only migration exactly once under a SQLite write transaction. */
export function migrateDatabase(
  db,
  { clock = systemClock, directory = migrationsDir } = {},
) {
  try {
    const files = migrationFiles(directory);
    db.exec(ledgerSql);
    const readApplied = db.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );
    return db
      .transaction(() => {
        const applied = readApplied.all();
        if (
          applied.some(
            ({ version }, index) => version !== files[index]?.version,
          )
        ) {
          throw new Error(
            "Database schema is newer than or inconsistent with this application",
          );
        }
        const pending = files.slice(applied.length);
        for (const { version, name } of pending) {
          db.exec(readFileSync(new URL(name, directory), "utf8"));
          record.run(version, utcIso(clock.now()));
        }
        return { applied: pending.length, version: files.at(-1).version };
      })
      .immediate();
  } catch (cause) {
    const busy = cause.code?.startsWith("SQLITE_BUSY");
    throw new PipelineError(
      busy ? "DATABASE_BUSY" : "DATABASE_MIGRATION_FAILED",
      undefined,
      {
        stage: "storage",
        cause,
        retryable: Boolean(busy),
      },
    );
  }
}
