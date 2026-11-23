import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readConfig } from "../config/env.js";
import { openDatabase } from "../db/connection.js";
import { migrateDatabase } from "../db/migrate.js";
import { requestReplay } from "../ingestion/replay.js";
import { publicError } from "../core/errors.js";

// Administration remains local. The running worker processes the persisted request.
export function main() {
  let db;
  try {
    const { values } = parseArgs({
      options: { correction: { type: "boolean" } },
    });
    const config = readConfig();
    db = openDatabase(config);
    migrateDatabase(db);
    console.log(
      JSON.stringify(
        requestReplay(db, config, values.correction ? "correction" : "replay"),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(JSON.stringify(publicError(error)));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
