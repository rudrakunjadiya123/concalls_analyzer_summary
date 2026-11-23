import { setTimeout as sleep } from "node:timers/promises";
import { PipelineError, publicError } from "../../utils/errors.js";
import { systemClock, utcIso } from "../../utils/clock.js";
import { atomicWrite } from "../../utils/storage.js";
import {
  activeCompanies,
  createDiscoveryRepository,
} from "../ingestion/discovery.js";

const hour = 3_600_000;
const day = 24 * hour;
const maxWindow = 14 * day;
const incomplete = new Set([
  "SOURCE_SCHEMA_CHANGED",
  "SOURCE_PAGINATION_INCOMPLETE",
]);

/** Poll bounded IST-date windows over durable UTC cursors, independently by source. */
export function createWatcher({
  db,
  config,
  sources,
  state,
  logger,
  clock = systemClock,
}) {
  const save = createDiscoveryRepository(db, logger);
  let running;
  const interval = config.POLL_INTERVAL_SECONDS * 1000;
  const live = config.DATA_MODE !== "fixture";
  const readScan = db.prepare("SELECT * FROM live_poll_cycles WHERE mode = ?");
  const beginScan =
    db.prepare(`INSERT INTO live_poll_cycles (mode, monitoring_from, started_at)
    VALUES (?, ?, ?) ON CONFLICT (mode) DO UPDATE SET started_at = excluded.started_at,
    completed_at = NULL, result = NULL, new_candidates = 0, selected_target_id = NULL, selected_documents = 0`);
  const recordCandidate = db
    .prepare(
      `UPDATE live_poll_cycles SET new_candidates = new_candidates + 1,
    selected_documents = selected_documents + (@limit = 0 OR selected_documents < @limit),
    selected_target_id = CASE WHEN @limit = 0 OR selected_documents < @limit
      THEN @target ELSE selected_target_id END
    WHERE mode = @mode AND started_at = @started AND completed_at IS NULL RETURNING selected_target_id`,
    )
    .pluck();
  const completeScan =
    db.prepare(`UPDATE live_poll_cycles SET completed_at = ?, result = ?
    WHERE mode = ? AND started_at = ?`);
  const nextDelay = (scan) =>
    scan
      ? Math.max(
          0,
          Date.parse(scan.started_at) + interval - clock.now().getTime(),
        )
      : 0;
  const getScan = db.transaction((to) => {
    const priorScan = readScan.get(config.DATA_MODE);
    // Resume an interrupted scan with the same cutoff and selection.
    if (priorScan && !priorScan.completed_at) return priorScan;
    if (nextDelay(priorScan)) return null;
    beginScan.run(
      config.DATA_MODE,
      utcIso(new Date(to.getTime() - interval)),
      utcIso(to),
    );
    return readScan.get(config.DATA_MODE);
  }).immediate;

  async function pollPartition(
    adapter,
    company,
    { from, to, manual, force, scan, signal },
  ) {
    const source = adapter.source;
    const partition = company?.id ?? "market";
    const previous = state.cursor(source, partition);
    const now = clock.now();
    const last = previous?.last_successful_window_end;
    if (scan && last && last >= utcIso(to))
      return { result: "success", queued: 0 };
    if (
      !force &&
      previous?.next_allowed_poll_at > utcIso(now) &&
      (!scan || previous.last_result !== "success")
    )
      return { result: "waiting", queued: 0 };
    const configuredOverlap = config.POLL_OVERLAP_HOURS * hour;
    // Market-wide date feeds can be large. Recheck one interval while retaining any unscanned gap.
    const overlap = scan
      ? Math.min(configuredOverlap, interval)
      : configuredOverlap;
    const fallbackStart = last
      ? Math.min(Date.parse(last), to.getTime()) - overlap
      : to.getTime() - (scan ? interval : config.INITIAL_BACKFILL_DAYS * day);
    // Keep inputs inside the supported Date range for very large operator-configured windows.
    let start =
      from?.getTime() ??
      Math.max(
        Date.UTC(1970, 0, 1),
        fallbackStart,
        scan ? Date.parse(scan.monitoring_from) : 0,
      );
    let queued = 0;
    const windowStep = adapter.source === "BSE" && !company ? day : maxWindow;
    for (; start < to.getTime(); start += windowStep) {
      signal?.throwIfAborted();
      const started = clock.now();
      const end = new Date(Math.min(start + windowStep, to.getTime()));
      if (!manual) state.start(source, partition, started);
      try {
        const { complete, records, diagnostics, fetchedPages } =
          await adapter.discover({
            from: new Date(start),
            to: end,
            signal,
            company,
          });
        signal?.throwIfAborted();
        if (!complete) {
          const failure = new PipelineError("SOURCE_PAGINATION_INCOMPLETE");
          failure.diagnostic = { reason: diagnostics.reason, fetchedPages };
          throw failure;
        }
        // Exchanges use inclusive calendar dates. Filter those pages to our half-open UTC window.
        const windowRecords = records.filter(({ publishedAt }) =>
          publishedAt
            ? Date.parse(publishedAt) >= start &&
              Date.parse(publishedAt) < end.getTime()
            : !scan,
        );
        const inWindow = [];
        for (const filing of windowRecords) {
          const reviewed = adapter.reviewAnnouncement
            ? await adapter.reviewAnnouncement(filing, { signal })
            : filing;
          if (reviewed) inWindow.push(reviewed);
        }
        queued += db
          .transaction(() => {
            let discovered = 0;
            const admit =
              scan &&
              ((target) => {
                discovered++;
                const limit = config.LIVE_MAX_DOCUMENTS_PER_POLL;
                // The durable count applies the same limit across sources and process restarts.
                const selected = recordCandidate.get({
                  mode: config.DATA_MODE,
                  started: scan.started_at,
                  target,
                  limit,
                });
                if (!selected) throw new PipelineError("JOB_LEASE_LOST");
                return selected === target;
              });
            const count = save(
              inWindow,
              company,
              adapter,
              utcIso(clock.now()),
              {
                admit,
                exchangeAnnouncements: Boolean(adapter.reviewAnnouncement),
              },
            );
            state.finish({
              source,
              partition,
              result: "success",
              started,
              end,
              count: scan ? discovered : count,
              recordCursor: !manual,
              next:
                !scan && end.getTime() >= to.getTime()
                  ? new Date(clock.now().getTime() + interval)
                  : null,
            });
            return count;
          })
          .immediate();
        logger?.info("source_poll_success", {
          stage: "source",
          source,
          count: inWindow.length,
          duration_ms: clock.now() - started,
        });
      } catch (error) {
        signal?.throwIfAborted();
        const code = publicError(error).error.code;
        const result =
          code === "SOURCE_FORBIDDEN"
            ? "blocked"
            : incomplete.has(code)
              ? "incomplete"
              : "error";
        const next = new Date(
          Math.max(
            scan
              ? Date.parse(scan.started_at) + interval
              : clock.now().getTime() + interval,
            Date.parse(state.state(source)?.paused_until) || 0,
          ),
        );
        db.transaction(() =>
          state.finish({
            source,
            partition,
            result,
            code,
            started,
            next,
            recordCursor: !manual,
          }),
        ).immediate();
        if (result === "incomplete") {
          // Save a redacted schema diagnostic. Never copy the provider body or request URL.
          await atomicWrite(
            config.DATA_DIR,
            `intermediate/source-${source}-diagnostic.json`,
            JSON.stringify({
              source,
              code,
              recorded_at: utcIso(clock.now()),
              fetched_pages: Number.isSafeInteger(
                error.diagnostic?.fetchedPages,
              )
                ? error.diagnostic.fetchedPages
                : null,
            }),
          ).catch(() =>
            logger?.warn("source_diagnostic_write_failed", {
              stage: "source",
              source,
            }),
          );
        }
        logger?.warn("source_poll_failed", {
          stage: "source",
          source,
          error_code: code,
          duration_ms: clock.now() - started,
        });
        return { result, code, queued };
      }
    }
    return { result: "success", queued };
  }

  async function cycle({
    from,
    to = clock.now(),
    manual = false,
    force = false,
    automatic = false,
    company: symbol,
    signal,
  } = {}) {
    signal?.throwIfAborted();
    const scan = automatic && live ? getScan(to) : null;
    if (automatic && live && !scan) return [];
    if (scan) to = new Date(scan.started_at);
    const watchlist = activeCompanies(db).filter(
      (company) => !symbol || symbol === company.nseSymbol,
    );
    if (symbol && !watchlist.length)
      throw new PipelineError("UNVERIFIED_COMPANY");
    const buckets = await Promise.allSettled(
      Object.values(sources)
        .filter((source) => source.enabled)
        .map(async (adapter) => {
          // Each authorized feed has one market checkpoint, independent of manual company queries.
          if (scan)
            return {
              source: adapter.source,
              ...(await pollPartition(adapter, undefined, {
                to,
                scan,
                signal,
              })),
            };
          const eligible = watchlist
            .filter((company) => adapter.eligible(company))
            .map((company) => ({
              company,
              last:
                state.cursor(adapter.source, company.id)
                  ?.last_poll_started_at ?? "",
            }))
            .sort((a, b) => a.last.localeCompare(b.last));
          if (!eligible.length) {
            state.finish({
              source: adapter.source,
              result: "disabled",
              code: "UNVERIFIED_COMPANY",
              started: clock.now(),
              recordCursor: false,
            });
            return {
              source: adapter.source,
              result: "disabled",
              code: "UNVERIFIED_COMPANY",
              queued: 0,
            };
          }
          const results = [];
          for (const { company } of eligible) {
            const outcome = await pollPartition(adapter, company, {
              from,
              to,
              manual,
              force,
              signal,
            });
            results.push(outcome);
            if (
              [
                "SOURCE_FORBIDDEN",
                "SOURCE_RATE_LIMITED",
                "SOURCE_UNAVAILABLE",
              ].includes(outcome.code)
            )
              break;
          }
          const failed = results.find(
            ({ result }) => !["success", "waiting"].includes(result),
          );
          const waiting = results.every(({ result }) => result === "waiting");
          return {
            source: adapter.source,
            result: failed?.result ?? (waiting ? "waiting" : "success"),
            ...(failed ? { code: failed.code } : {}),
            queued: results.reduce((sum, { queued }) => sum + queued, 0),
          };
        }),
    );
    const failure = buckets.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
    signal?.throwIfAborted();
    const outcomes = buckets.map(({ value }) => value);
    if (scan)
      completeScan.run(
        utcIso(clock.now()),
        outcomes.every(({ result }) => result === "success")
          ? "success"
          : "partial",
        config.DATA_MODE,
        scan.started_at,
      );
    return outcomes;
  }

  return {
    status() {
      const scan = live && readScan.get(config.DATA_MODE);
      return scan
        ? {
            interval_seconds: config.POLL_INTERVAL_SECONDS,
            started_at: scan.started_at,
            completed_at: scan.completed_at,
            result: scan.result,
            new_candidates: scan.new_candidates,
            selected_documents: scan.selected_documents,
            discarded_candidates: scan.new_candidates - scan.selected_documents,
          }
        : null;
    },
    tick(options) {
      // A slow poll shares the same promise with overlapping callers.
      running ??= cycle(options).finally(() => {
        running = undefined;
      });
      return running;
    },
    async run(signal, options = {}) {
      while (!signal.aborted) {
        let delay = interval;
        try {
          await this.tick({ ...options, signal, automatic: true });
          if (live) delay = nextDelay(readScan.get(config.DATA_MODE));
        } catch (error) {
          if (!signal.aborted)
            logger?.error("watcher_error", {
              stage: "source",
              error_code: publicError(error).error.code,
            });
        }
        await sleep(delay, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
  };
}
