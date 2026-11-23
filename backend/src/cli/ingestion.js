import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createLogger } from "../core/logger.js";
import { PipelineError, publicError } from "../core/errors.js";
import { readConfig } from "../config/env.js";
import { openDatabase } from "../db/connection.js";
import { migrateDatabase } from "../db/migrate.js";
import { seedWatchlist } from "../db/seed.js";
import { createIngestionService } from "../ingestion/service.js";

async function main() {
  let logger = createLogger();
  let db;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const [command, ...args] = process.argv.slice(2);
    const config = readConfig();
    logger = createLogger({ level: config.LOG_LEVEL });
    if (
      ![
        "once",
        "backfill",
        "diagnose",
        "demo",
        "extract",
        "summarize",
        "import-pdf",
      ].includes(command)
    )
      throw new PipelineError("CONFIG_INVALID");
    const { values } = parseArgs({
      args,
      options:
        command === "import-pdf"
          ? {
              file: { type: "string" },
              "source-url": { type: "string" },
              "archive-exchange": { type: "string" },
              company: { type: "string" },
              title: { type: "string" },
              "published-at": { type: "string" },
              authorized: { type: "boolean" },
              summarize: { type: "boolean" },
            }
          : command === "backfill"
            ? { company: { type: "string" }, days: { type: "string" } }
            : {},
    });
    const maximumDays = config.INITIAL_BACKFILL_DAYS;
    const days = values.days === undefined ? maximumDays : Number(values.days);
    if (
      command === "backfill" &&
      (!Number.isSafeInteger(days) ||
        days < 1 ||
        days > maximumDays ||
        (values.company !== undefined &&
          !/^[A-Z0-9][A-Z0-9&.-]{0,29}$/u.test(values.company)))
    ) {
      throw new PipelineError("CONFIG_INVALID");
    }
    if (
      ["demo", "extract", "summarize"].includes(command) &&
      (config.DATA_MODE !== "fixture" || !config.ENABLE_DEMO_REPLAY)
    )
      throw new PipelineError("SOURCE_NOT_AUTHORIZED");
    if (command === "summarize" && config.AI_PROVIDER !== "mock")
      throw new PipelineError("AI_PROVIDER_RESTRICTED");
    db = openDatabase(config);
    migrateDatabase(db);
    seedWatchlist(db);
    const ingestion = createIngestionService(db, config, { logger });
    if (command === "import-pdf") {
      const result = await ingestion.importPdf(
        {
          filePath: values.file,
          sourceUrl: values["source-url"],
          archiveExchange: values["archive-exchange"],
          company: values.company,
          title: values.title,
          publishedAt: values["published-at"],
          authorized: values.authorized,
          summarize: values.summarize,
        },
        controller.signal,
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.imported) process.exitCode = 1;
      return;
    }
    if (command === "diagnose") {
      console.log(JSON.stringify(ingestion.status(), null, 2));
      return;
    }
    if (!Object.values(ingestion.sources).some(({ enabled }) => enabled))
      throw new PipelineError("SOURCE_NOT_AUTHORIZED");
    const end = new Date();
    // Manual historical queries do not move the automatic polling cursor past a gap.
    const range =
      command === "backfill"
        ? {
            from: new Date(end.getTime() - days * 86_400_000),
            to: end,
            manual: true,
            company: values.company,
          }
        : {};
    const result = await ingestion.once({
      ...range,
      signal: controller.signal,
      processAi: command !== "extract",
    });
    if (command === "extract") {
      // Print diagnostic identifiers and decisions while keeping source text private.
      const documents = db
        .prepare(
          `SELECT DISTINCT d.id AS document_id, p.page_count, r.classification, r.reason_code, r.decision
        FROM documents d JOIN document_sources s ON s.document_id=d.id JOIN source_filings f ON f.id=s.filing_id
        LEFT JOIN pdf_extractions p ON p.document_id=d.id LEFT JOIN document_reviews r ON r.source_id=s.id
        WHERE f.source='FIXTURE' ORDER BY d.id`,
        )
        .all();
      console.log(
        JSON.stringify({ mode: "fixture", ...result, documents }, null, 2),
      );
      if (
        !documents.length ||
        documents.some(
          (item) => item.page_count === null || item.classification === null,
        )
      )
        process.exitCode = 1;
    } else if (command === "summarize") {
      const summaries = db
        .prepare(
          `SELECT s.id AS summary_id,s.transcript_id,s.model_id,s.prompt_version,
        s.published_at,o.id AS outbox_event_id FROM summaries s JOIN outbox_events o ON o.summary_id=s.id
        WHERE s.is_mock=1 AND s.validation_status='passed' ORDER BY o.id`,
        )
        .all();
      console.log(
        JSON.stringify(
          { mode: "fixture", is_mock: true, ...result, summaries },
          null,
          2,
        ),
      );
      if (!summaries.length) process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({ mode: config.DATA_MODE, ...result }, null, 2),
      );
    }
    if (
      result.polls.some(
        ({ result: outcome }) => !["waiting", "success"].includes(outcome),
      )
    )
      process.exitCode = 1;
  } catch (error) {
    logger.error("ingestion_command_failed", {
      stage: "source",
      error_code: error?.code?.startsWith("ERR_PARSE_ARGS_")
        ? "CONFIG_INVALID"
        : publicError(error).error.code,
    });
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    db?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
