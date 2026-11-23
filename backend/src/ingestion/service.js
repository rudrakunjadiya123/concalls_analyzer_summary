import { setTimeout as sleep } from "node:timers/promises";
import { sourceGrants } from "../config/env.js";
import { systemClock, utcIso } from "../core/clock.js";
import { clearDownloadTemps } from "../core/storage.js";
import { createJobRepository } from "../jobs/repository.js";
import { createDownloadWorker } from "../jobs/worker.js";
import {
  backfillDocumentSources,
  createPdfRepository,
} from "../jobs/pdfRepository.js";
import { createPdfWorker } from "../jobs/pdfWorker.js";
import { withPipelineLease } from "../scheduler/lease.js";
import { createPollState } from "../scheduler/pollCursor.js";
import { createWatcher } from "../scheduler/watcher.js";
import { createSources } from "../sources/factory.js";
import { FIXTURE_FROM, FIXTURE_TO } from "../sources/fixture.js";
import { createGeminiProvider } from "../ai/gemini.js";
import { createMockProvider } from "../ai/mock.js";
import { createExtractiveProvider } from "../ai/extractive.js";
import { createAiRepository } from "../jobs/aiRepository.js";
import { createAiWorker } from "../jobs/aiWorker.js";
import { runReplayQueue } from "./replay.js";
import { importLocalPdf } from "./local-pdf.js";

/** Wire source, download and private PDF stages to one local SQLite database. */
export function createIngestionService(
  db,
  config,
  { logger, clock = systemClock, network, aiProvider } = {},
) {
  const state = createPollState(db, sourceGrants(config), clock);
  const sources = createSources(config, {
    policy: state,
    logger,
    clock,
    network,
  });
  const jobs = createJobRepository(db, {
    leaseSeconds: config.WORKER_LEASE_SECONDS,
    maxAttempts: config.MAX_JOB_ATTEMPTS,
    clock,
  });
  const worker = createDownloadWorker({ jobs, sources, config, logger, clock });
  const pdf = createPdfRepository(db, {
    leaseSeconds: config.WORKER_LEASE_SECONDS,
    maxAttempts: config.MAX_JOB_ATTEMPTS,
    clock,
  });
  const pdfWorker = createPdfWorker({ repository: pdf, config, logger, clock });
  const provider =
    aiProvider ??
    (config.AI_PROVIDER === "gemini"
      ? createGeminiProvider({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          factMode: config.GEMINI_FACT_MODE,
          temperature: config.AI_TEMPERATURE,
        })
      : config.AI_PROVIDER === "extractive"
        ? createExtractiveProvider()
        : createMockProvider());
  const ai = createAiRepository(db, config, provider, clock);
  const aiWorker = createAiWorker({
    repository: ai,
    provider,
    config,
    logger,
    clock,
  });
  const watcher = createWatcher({ db, config, sources, state, logger, clock });
  const fixture = config.DATA_MODE === "fixture";
  const autoStart = fixture
    ? config.FIXTURE_WATCH_ENABLED
    : Object.values(sources).some(({ enabled }) => enabled);
  let schedulerPhase = autoStart ? "starting" : "disabled";
  const options = fixture
    ? { from: new Date(FIXTURE_FROM), to: new Date(FIXTURE_TO) }
    : {};
  const lease = (signal, operation) =>
    withPipelineLease(
      db,
      signal,
      async (active) => {
        await clearDownloadTemps(config.DATA_DIR);
        backfillDocumentSources(db, utcIso(clock.now()));
        return operation(active);
      },
      { clock },
    );

  return {
    autoStart,
    sources,
    watcher,
    jobs,
    status() {
      return {
        data_mode: config.DATA_MODE,
        scheduler_enabled: autoStart,
        scheduler_running: schedulerPhase === "running",
        scheduler_phase: schedulerPhase,
        live_poll: watcher.status(),
        sources: Object.fromEntries(
          Object.entries(sources).map(([name, adapter]) => {
            const row = state.state(name);
            return [
              name,
              {
                ...adapter.health(),
                last_failure_at: row?.last_failure_at ?? null,
                paused_until:
                  row?.paused_until &&
                  Date.parse(row.paused_until) > clock.now().getTime()
                    ? row.paused_until
                    : null,
                last_poll_latency_ms: row?.latency_ms ?? null,
                documents_discovered: row?.documents_discovered ?? null,
              },
            ];
          }),
        ),
        download_jobs: jobs.counts(),
        pdf_processing: pdf.counts(),
        ai_processing: {
          provider: provider.id,
          model: provider.model,
          is_mock: provider.isMock,
          ...provider.status(),
          real_processing_enabled:
            !provider.isMock && provider.status().configured,
          paused_until: ai.pausedUntil(),
          jobs: ai.counts(),
        },
      };
    },
    async run(signal) {
      const operate = async (active) => {
        schedulerPhase = "running";
        const sibling = new AbortController();
        const combined = AbortSignal.any([active, sibling.signal]);
        const stopOther = (error) => {
          sibling.abort();
          throw error;
        };
        try {
          const results = await Promise.allSettled([
            watcher.run(combined, options).catch(stopOther),
            worker.run(combined).catch(stopOther),
            pdfWorker.run(combined).catch(stopOther),
            aiWorker.run(combined).catch(stopOther),
            runReplayQueue({
              db,
              config,
              sources,
              clock,
              logger,
              signal: combined,
            }).catch(stopOther),
          ]);
          const failed = results.find(({ status }) => status === "rejected");
          if (failed) throw failed.reason;
        } finally {
          schedulerPhase = "starting";
        }
      };
      // A paused process can lose its lease. Drain the old workers, then reacquire ownership.
      while (!signal.aborted) {
        try {
          return await lease(signal, operate);
        } catch (error) {
          if (signal.aborted) return;
          if (
            !["DATABASE_BUSY", "SQLITE_BUSY", "JOB_LEASE_LOST"].includes(
              error.code,
            )
          ) {
            schedulerPhase = "failed";
            throw error;
          }
          schedulerPhase = "recovering";
          if (error.code === "JOB_LEASE_LOST")
            logger?.warn("scheduler_lease_recovering", {
              stage: "source",
              error_code: error.code,
            });
          await sleep(1000, undefined, { signal }).catch((failure) => {
            if (!signal.aborted) throw failure;
          });
        }
      }
    },
    importPdf: (input, signal) =>
      lease(signal, async (active) => {
        const imported = await importLocalPdf({
          db,
          jobs,
          config,
          clock,
          signal: active,
          input,
        });
        if (imported.imported) {
          await pdfWorker.drain(active);
          if (input.summarize) await aiWorker.drain(active);
        }
        return {
          ...imported,
          pdf_processing: pdf.counts(),
          ai_processing: ai.counts(),
        };
      }),
    once: ({ signal, processAi = true, ...overrides } = {}) =>
      lease(signal, async (active) => {
        const polls = await watcher.tick({
          ...options,
          force: true,
          ...overrides,
          signal: active,
        });
        await worker.drain(active);
        await pdfWorker.drain(active);
        if (processAi) await aiWorker.drain(active);
        return {
          polls,
          downloads: jobs.counts(),
          pdf_processing: pdf.counts(),
          ai_processing: ai.counts(),
        };
      }),
  };
}
