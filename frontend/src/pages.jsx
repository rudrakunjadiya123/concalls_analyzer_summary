import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EXTRACTIVE_MODEL } from "@finosauras/shared/constants";
import { apiPath, useApi } from "./api.js";
import { mergeHistory, mergeLatest } from "./live.js";
import {
  HistoryCard,
  Pill,
  pretty,
  QueryState,
  SourceLink,
  SourcePanel,
  SummaryLabel,
  Timestamp,
} from "./components.jsx";

const phases = {
  connected: "Summary updates connected",
  connecting: "Connecting summary updates",
  offline: "Summary updates disconnected",
};
const watcherPhases = {
  starting: "starting",
  running: "active",
  recovering: "recovering",
  disabled: "disabled",
  failed: "stopped",
};
const newest = (a, b) =>
  (b.latest_summary?.call_date ?? "").localeCompare(
    a.latest_summary?.call_date ?? "",
  ) ||
  (b.latest_summary?.published_at ?? "").localeCompare(
    a.latest_summary?.published_at ?? "",
  ) ||
  a.display_name.localeCompare(b.display_name);

export function Overview({ live, status }) {
  const companies = useApi(live.ready ? "/watchlist" : null, live.revision);
  const data = status.data;
  const market = Boolean(data && data.data_mode !== "fixture");
  const marketSummaries = useApi(
    market ? "/summaries?limit=5" : null,
    live.revision,
  );
  const [search, setSearch] = useState("");
  const [sector, setSector] = useState("");
  const [quarter, setQuarter] = useState("");
  const [sort, setSort] = useState("latest");
  const rows = (companies.data ?? []).map((row) => mergeLatest(row, live.last));
  const sectors = [
    ...new Set(rows.map((row) => row.sector).filter(Boolean)),
  ].sort();
  const quarters = [
    ...new Set(rows.map((row) => row.latest_summary?.quarter).filter(Boolean)),
  ]
    .sort()
    .reverse();
  const matches = rows
    .filter(
      (row) =>
        (!sector || sector === row.sector) &&
        (!quarter || quarter === row.latest_summary?.quarter) &&
        [row.display_name, row.sector, row.nse_symbol, row.bse_scrip_code]
          .join(" ")
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort(
      sort === "latest"
        ? newest
        : (a, b) => a.display_name.localeCompare(b.display_name),
    );
  const latestPoll = Object.values(data?.sources ?? {})
    .map((source) => source.last_poll_completed_at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const pending = live.last && data && live.last.event_id > data.last_event_id;
  const latest = live.last?.data.summary;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Earnings call intelligence</p>
          <h1>Company watchlist</h1>
        </div>
        <Pill tone={live.phase === "connected" ? "good" : "alert"}>
          {phases[live.phase]}
        </Pill>
      </header>
      <QueryState result={status}>
        {data && (
          <div className="stats">
            <div className="panel stat">
              <span>
                {market ? "Saved watchlist companies" : "Watched companies"}
              </span>
              <strong>{rows.length}</strong>
            </div>
            <div className="panel stat">
              <span>Companies summarized</span>
              <strong>
                {pending
                  ? new Set(
                      rows
                        .filter((row) => row.latest_summary)
                        .map((row) => row.id),
                    ).size
                  : data.processed_companies}
              </strong>
            </div>
            <div className="panel stat">
              <span>Published summaries</span>
              <strong>
                {data.published_summaries + Number(Boolean(pending))}
              </strong>
            </div>
            <div className="panel stat">
              <span>
                {data.data_mode === "fixture" ? "Demo watcher" : "Live watcher"}{" "}
                {watcherPhases[data.scheduler_phase] ??
                  (data.scheduler_running ? "active" : "unavailable")}
              </span>
              <strong className="stat-time">
                <Timestamp value={latestPoll} />
              </strong>
              <small>
                {data.data_mode === "fixture"
                  ? "Last demo poll"
                  : "Last completed poll"}{" "}
                · IST
              </small>
            </div>
          </div>
        )}
      </QueryState>
      {data?.live_poll && (
        <p className="notice" role="status">
          {data.live_poll.completed_at
            ? data.live_poll.result === "partial"
              ? "Partial market-wide scan"
              : "Last market-wide scan"
            : "Market-wide scan in progress"}{" "}
          ·{" "}
          <Timestamp
            value={data.live_poll.completed_at ?? data.live_poll.started_at}
          />
          {" · "}
          {data.live_poll.new_candidates} new transcript candidates
          {" · "}
          {data.live_poll.selected_documents} documents queued
          {" · "}
          {data.live_poll.discarded_candidates} candidates skipped
        </p>
      )}
      {latest && (
        <p className="notice latest" role="status">
          {live.last.type === "summary.updated"
            ? "Updated summary"
            : "New summary"}{" "}
          ·{" "}
          <Link to={`/summaries/${live.last.data.summary_id}`}>
            {latest.company}
          </Link>{" "}
          · <Timestamp value={live.last.emitted_at} />
        </p>
      )}
      {market && (
        <section aria-labelledby="market-summaries">
          <h2 id="market-summaries" className="section-heading">
            Latest market summaries
          </h2>
          <QueryState result={marketSummaries}>
            {marketSummaries.data?.length ? (
              <div className="history">
                {marketSummaries.data.map((summary) => (
                  <HistoryCard key={summary.id} summary={summary} showCompany />
                ))}
              </div>
            ) : (
              <p className="panel empty">No market summaries published yet.</p>
            )}
          </QueryState>
        </section>
      )}
      <section className="panel watchlist" aria-labelledby="watchlist">
        <header className="list-head">
          <h2 id="watchlist">Tracked companies</h2>
          <span className="muted">
            {matches.length} of {rows.length} companies
          </span>
        </header>
        <div className="filters">
          <label>
            Search
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Company, symbol or sector"
            />
          </label>
          <label>
            Sector
            <select
              value={sector}
              onChange={(event) => setSector(event.target.value)}
            >
              <option value="">All sectors</option>
              {sectors.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Quarter
            <select
              value={quarter}
              onChange={(event) => setQuarter(event.target.value)}
            >
              <option value="">All quarters</option>
              {quarters.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Sort
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="latest">Latest first</option>
              <option value="name">Company name</option>
            </select>
          </label>
        </div>
        <QueryState result={companies}>
          {matches.length ? (
            <div
              className="scroll-table"
              tabIndex={0}
              role="region"
              aria-label="Watchlist results"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Company</th>
                    <th scope="col">Sector</th>
                    <th scope="col">Quarter</th>
                    <th scope="col">Call date</th>
                    <th scope="col">Published · IST</th>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((row) => {
                    const entry = row.latest_summary;
                    return (
                      <tr key={row.id}>
                        <th scope="row">
                          <Link to={`/companies/${row.id}`}>
                            {row.display_name}
                          </Link>
                          <small>{row.nse_symbol}</small>
                        </th>
                        <td>{row.sector ?? "Unknown"}</td>
                        <td>
                          {entry ? (
                            <Link to={`/summaries/${entry.id}`}>
                              {entry.quarter ?? "Unknown"}
                            </Link>
                          ) : (
                            <span className="muted">Unknown</span>
                          )}
                        </td>
                        <td>
                          <Timestamp value={entry?.call_date} onlyDate />
                        </td>
                        <td>
                          <Timestamp value={entry?.published_at} />
                        </td>
                        <td>
                          {entry?.is_mock ? (
                            <Pill tone="demo">Synthetic fixture</Pill>
                          ) : row.source_availability.length ? (
                            row.source_availability.join(" / ")
                          ) : (
                            <span className="muted">Unavailable</span>
                          )}
                        </td>
                        <td>
                          <Pill tone={entry ? "good" : "neutral"}>
                            {pretty(row.status)}
                          </Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No companies match these filters.</p>
          )}
        </QueryState>
      </section>
      {data && <SourcePanel status={data} />}
    </>
  );
}

export function Company({ live }) {
  const { id } = useParams();
  const company = useApi(live.ready ? `/companies/${id}` : null, live.revision);
  const [page, setPage] = useState(null);
  const first = useApi(
    live.ready ? `/companies/${id}/summaries` : null,
    live.revision,
  );
  const path = apiPath(`/companies/${id}/summaries`, { cursor: page });
  const older = useApi(page ? path : null, live.revision);
  const history = page ? older : first;
  const push = live.last?.data.company_id === id ? live.last : null;
  const rows = page
    ? (history.data ?? [])
    : mergeHistory(history.data ?? [], push);
  return (
    <>
      <Link className="back" to="/">
        ← Watchlist
      </Link>
      <QueryState result={company}>
        {company.data && (
          <>
            <header className="page-head">
              <div>
                <p className="eyebrow">{company.data.sector}</p>
                <h1>{company.data.display_name}</h1>
              </div>
              <Pill tone={company.data.identity_verified ? "good" : "neutral"}>
                {company.data.identity_verified
                  ? "Identity verified"
                  : "Identity unverified"}
              </Pill>
            </header>
            <dl className="panel details">
              <div>
                <dt>NSE symbol</dt>
                <dd>{company.data.nse_symbol ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>BSE code</dt>
                <dd>{company.data.bse_scrip_code ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>ISIN</dt>
                <dd>{company.data.isin ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Latest verified call</dt>
                <dd>
                  <Timestamp
                    value={
                      mergeLatest(company.data, push).latest_summary?.call_date
                    }
                    onlyDate
                  />
                </dd>
              </div>
            </dl>
          </>
        )}
      </QueryState>
      <h2 className="section-heading">Call summaries</h2>
      <QueryState result={history}>
        {rows.length ? (
          <div className="history">
            {rows.map((row) => (
              <HistoryCard key={row.id} summary={row} />
            ))}
          </div>
        ) : (
          <p className="panel empty">
            {company.data?.status === "processing"
              ? "A filing is being processed."
              : company.data?.status === "needs_document"
                ? "The transcript attachment is unavailable."
                : company.data?.status === "skipped"
                  ? "The automatic scan skipped this transcript candidate."
                  : "No transcript yet. Source availability is shown on the watchlist."}
          </p>
        )}
        <div className="actions">
          {page && (
            <button onClick={() => setPage(null)}>Newest summaries</button>
          )}
          {history.pagination?.next_cursor && (
            <button onClick={() => setPage(history.pagination.next_cursor)}>
              Older summaries
            </button>
          )}
        </div>
      </QueryState>
    </>
  );
}

// Render summary values as text and attach evidence using the validator's claim paths.
function Evidence({ rows, path }) {
  const matches = rows.filter(
    (row) => row.claim_path === path || row.claim_path.startsWith(`${path}.`),
  );
  if (!matches.length) return null;
  return (
    <details className="evidence">
      <summary>
        Evidence ·{" "}
        {Array.from(
          new Set(matches.map((row) => `p. ${row.page_number}`)),
        ).join(", ")}
      </summary>
      {matches.map((row, index) => (
        <figure key={`${row.claim_path}-${row.source_block_id}-${index}`}>
          <blockquote>{row.supporting_quote}</blockquote>
          <figcaption>
            Page {row.page_number} · {row.speaker ?? "Speaker unknown"} ·{" "}
            {row.verification_status}
          </figcaption>
        </figure>
      ))}
    </details>
  );
}

export function Summary({ live }) {
  const { id } = useParams();
  const result = useApi(live.ready ? `/summaries/${id}` : null, live.revision);
  const evidence = useApi(live.ready ? `/summaries/${id}/evidence` : null);
  const [view, setView] = useState(null);
  const [feedback, setFeedback] = useState("");
  const data = result.data;
  const record = data?.json;
  const cite = (path) => <Evidence rows={evidence.data ?? []} path={path} />;
  const section = (name, items, render) => (
    <section className="panel summary-section">
      <h2>{name}</h2>
      {items.length ? render() : <p className="muted">No verified items.</p>}
    </section>
  );
  const bullets = (name, key) =>
    section(name, record[key], () => (
      <ul className="claims">
        {record[key].map((line, index) => (
          <li key={index}>
            {line}
            {cite(`${key}[${index}]`)}
          </li>
        ))}
      </ul>
    ));
  return (
    <QueryState result={result}>
      {record && (
        <>
          <Link className="back" to={`/companies/${data.company_id}`}>
            ← Company history
          </Link>
          <header className="page-head summary-head">
            <div>
              <p className="eyebrow">Call summary</p>
              <h1>{record.company}</h1>
              <p>
                {record.quarter ?? "Quarter unconfirmed"} · Call{" "}
                <Timestamp value={record.call_date} onlyDate />
              </p>
            </div>
            <div className="tags">
              <SummaryLabel summary={{ ...data, source: record.source }} />
            </div>
          </header>
          <div className="panel summary-tools">
            <div className="summary-meta">
              <span>
                Published <Timestamp value={data.published_at} />
              </span>
              <span>
                {data.model_id === EXTRACTIVE_MODEL
                  ? "Local extractive summary"
                  : data.model_id}{" "}
                · {data.prompt_version}
              </span>
              <span>
                {data.validation.evidence_count} verified evidence links
              </span>
            </div>
            <div className="actions">
              <button
                aria-pressed={view === "json"}
                onClick={() => setView(view === "json" ? null : "json")}
              >
                View JSON
              </button>
              <button
                aria-pressed={view === "markdown"}
                onClick={() => setView(view === "markdown" ? null : "markdown")}
              >
                View Markdown
              </button>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(data.markdown);
                    setFeedback("Markdown copied.");
                  } catch {
                    setView("markdown");
                    setFeedback(
                      "Clipboard unavailable. Select the Markdown to copy it.",
                    );
                  }
                }}
              >
                Copy Markdown
              </button>
              {(data.sources.length
                ? data.sources
                : [{ source: record.source, source_url: record.source_url }]
              ).map(({ source, source_url }, index) => (
                <SourceLink
                  key={`${source}-${index}`}
                  source={source}
                  url={source_url}
                />
              ))}
            </div>
            {feedback && <p role="status">{feedback}</p>}
            {view && (
              <pre
                aria-label={
                  view === "json" ? "Summary JSON" : "Summary Markdown"
                }
              >
                {view === "json"
                  ? JSON.stringify(record, null, 2)
                  : data.markdown}
              </pre>
            )}
          </div>
          {data.is_mock && (
            <p className="notice demo">
              {record.source === "FIXTURE"
                ? "Synthetic demo · fictional company and financial figures."
                : "Unverified/mock summarization."}
            </p>
          )}
          {data.validation.warnings.length > 0 && (
            <div className="notice alert">
              Validation warnings
              <ul>
                {data.validation.warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {evidence.error && (
            <div className="notice error" role="alert">
              Evidence unavailable.{" "}
              <button onClick={evidence.retry}>Retry evidence</button>
            </div>
          )}
          <div className="summary-grid">
            {bullets("Key takeaways", "tldr")}
            {section("Key metrics", record.key_metrics, () => (
              <div
                className="scroll-table"
                tabIndex={0}
                role="region"
                aria-label="Key metrics"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Value</th>
                      <th scope="col">Context</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.key_metrics.map(
                      ({ metric, value, context }, index) => (
                        <tr key={index}>
                          <th scope="row">{metric}</th>
                          <td>{value}</td>
                          <td>
                            {context}
                            {cite(`key_metrics[${index}]`)}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            ))}
            {bullets("Management commentary", "management_commentary")}
            {bullets("Guidance", "guidance")}
            {section("Segment performance", record.segment_performance, () => (
              <ul className="claims">
                {record.segment_performance.map(({ segment, notes }, index) => (
                  <li key={index}>
                    <strong>{segment}</strong>
                    <p>{notes}</p>
                    {cite(`segment_performance[${index}]`)}
                  </li>
                ))}
              </ul>
            ))}
            {section("Notable Q&A", record.notable_qa, () =>
              record.notable_qa.map(({ question, answer, asked_by }, index) => (
                <article className="qa" key={index}>
                  <h3>{question}</h3>
                  <p className="muted">{asked_by ?? "Analyst unknown"}</p>
                  <p>{answer}</p>
                  {cite(`notable_qa[${index}]`)}
                </article>
              )),
            )}
            {bullets("Risks", "risks")}
          </div>
        </>
      )}
    </QueryState>
  );
}
