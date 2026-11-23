import { ConfigError, readConfig } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { PipelineError, publicError } from "../utils/errors.js";
import { openDatabase } from "../config/database.js";
import { migrateDatabase } from "../models/migrate.js";
import { seedWatchlist } from "../models/seed.js";
import { verifyWatchlist } from "../models/verifyWatchlist.js";

// Share initialization with the API so local maintenance uses the same database settings.
const command = process.argv[2];
try {
  if (!["migrate", "seed", "verify-watchlist"].includes(command))
    throw new PipelineError("BAD_REQUEST");
  const db = openDatabase(readConfig());
  try {
    const result = migrateDatabase(db);
    if (command === "verify-watchlist")
      console.log(
        JSON.stringify(
          db
            .transaction(() => {
              seedWatchlist(db);
              return verifyWatchlist(db);
            })
            .immediate(),
        ),
      );
    else
      console.log(
        JSON.stringify(command === "seed" ? seedWatchlist(db) : result),
      );
  } finally {
    db.close();
  }
} catch (error) {
  createLogger().error("database_command_failed", {
    stage: "storage",
    error_code: publicError(error).error.code,
    config_fields: error instanceof ConfigError ? error.fields : undefined,
  });
  process.exitCode = 1;
}
