import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, readConfig } from "./config/env.js";
import { createLogger } from "./core/logger.js";
import { publicError } from "./core/errors.js";
import { openDatabase } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";
import { seedWatchlist } from "./db/seed.js";
import { createApp } from "./app.js";
import { createIngestionService } from "./ingestion/service.js";
import { attachSummariesSocket } from "./ws/server.js";

/** Initialize local state and start the HTTP listener with a close hook for callers. */
export async function startApi(
  config,
  { logger = createLogger({ level: config.LOG_LEVEL }) } = {},
) {
  const db = openDatabase(config);
  let socket;
  try {
    const { version } = migrateDatabase(db);
    const { total } = seedWatchlist(db);
    const ingestion = createIngestionService(db, config, { logger });
    const app = createApp({
      db,
      schemaVersion: version,
      mode: config.DATA_MODE,
      logger,
      ingestionStatus: ingestion.status,
      wsStatus: () => socket?.count() ?? 0,
    });
    const server = createServer(app);
    socket = attachSummariesSocket(server, db, config, logger);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.PORT, config.HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    logger.info("api_listening", {
      stage: "startup",
      port: server.address().port,
      count: total,
    });
    const controller = new AbortController();
    const watching = ingestion.autoStart
      ? ingestion.run(controller.signal).catch((error) => {
          if (!controller.signal.aborted)
            logger.error("ingestion_stopped", {
              stage: "source",
              error_code: publicError(error).error.code,
            });
        })
      : Promise.resolve();

    let closing;
    function close() {
      // Finish in-flight HTTP work before releasing SQLite. Bound the wait for stalled clients.
      controller.abort();
      closing ??= new Promise((resolve, reject) => {
        const socketsClosed = socket.close();
        const timeout = setTimeout(
          () => server.closeAllConnections(),
          5000,
        ).unref();
        server.close(async (error) => {
          clearTimeout(timeout);
          try {
            await Promise.all([watching, socketsClosed]);
            db.close();
          } catch (dbError) {
            reject(dbError);
            return;
          }
          if (error) reject(error);
          else resolve();
        });
      });
      return closing;
    }
    return { server, close };
  } catch (error) {
    await socket?.close();
    db.close();
    throw error;
  }
}

async function main() {
  let logger = createLogger();
  try {
    const config = readConfig();
    logger = createLogger({ level: config.LOG_LEVEL });
    const { server, close } = await startApi(config, { logger });
    async function shutdown(error) {
      if (error) {
        logger.error("server_error", {
          stage: "http",
          error_code: publicError(error).error.code,
        });
        process.exitCode = 1;
      }
      try {
        await close();
        logger.info("api_stopped", { stage: "shutdown" });
      } catch (failure) {
        logger.error("shutdown_failed", {
          stage: "shutdown",
          error_code: publicError(failure).error.code,
        });
        process.exitCode = 1;
      }
    }
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    server.once("error", (error) => void shutdown(error));
  } catch (error) {
    logger.error("startup_failed", {
      stage: "startup",
      error_code: publicError(error).error.code,
      config_fields: error instanceof ConfigError ? error.fields : undefined,
    });
    process.exitCode = 1;
  }
}

// Importing the entry point for validation and tests should never start the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
