import { Link } from "react-router-dom";

export const pretty = (text) =>
  text ? String(text).replaceAll("_", " ").replaceAll("-", " ") : "Unknown";
const timeFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});
const dateFormat = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeZone: "Asia/Kolkata",
});
const relativeFormat = new Intl.RelativeTimeFormat("en-IN", {
  numeric: "auto",
});
export function Timestamp({ value, onlyDate = false }) {
  if (!value) return <span className="muted">Unknown</span>;
  const date = new Date(value);
  const exact = (onlyDate ? dateFormat : timeFormat).format(date);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  const label =
    !onlyDate && minutes >= 0 && minutes < 60
      ? relativeFormat.format(-minutes, "minute")
      : exact;
  return (
    <time
      dateTime={value}
      title={value}
      aria-label={onlyDate ? exact : `${exact} IST`}
    >
      {label}
    </time>
  );
}

export function QueryState({ result, children }) {
  return (
    <>
      {result.error && (
        <div className="notice error" role="alert">
          <span>{result.error}</span>
          <button onClick={result.retry}>Retry</button>
        </div>
      )}
      {result.loading && (
        <div className="notice" role="status">
          Loading…
        </div>
      )}
      {result.data !== undefined && children}
    </>
  );
}

export function Pill({ children, tone = "neutral" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function SourcePanel({ status }) {
  const sources = Object.entries(status?.sources ?? {}).filter(
    ([key]) => key !== "FIXTURE" || status.data_mode === "fixture",
  );
  return (
    <section className="panel source-panel" aria-labelledby="source-health">
      <h2 id="source-health">Source health</h2>
      <dl className="source-list">
        {sources.map(([name, source]) => (
          <div key={name}>
            <dt>
              {name === "FIXTURE"
                ? "Fixture"
                : name === "LICENSED"
                  ? "Licensed feed"
                  : name}
            </dt>
            <dd>
              <Pill
                tone={
                  source.status === "blocked"
                    ? "alert"
                    : source.lastSuccessAt && source.enabled
                      ? "good"
                      : "neutral"
                }
              >
                {pretty(source.status)}
              </Pill>
              <span>
                Last success <Timestamp value={source.lastSuccessAt} />
              </span>
              {source.reason && (
                <span className="muted">
                  {pretty(source.reason).toLowerCase()}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="panel-foot">
        AI provider{" "}
        <strong>
          {status?.ai_processing?.is_mock
            ? "Mock"
            : (status?.ai_processing?.provider ?? "Unknown")}
        </strong>
        <span>
          {status?.ai_processing?.model ?? ""}{" "}
          {status?.ai_processing?.is_mock
            ? "· synthetic only"
            : status?.ai_processing?.probed
              ? "· model verified"
              : "· capability unverified"}
        </span>
      </div>
    </section>
  );
}

export function SummaryLabel({ summary }) {
  return (
    <>
      <Pill tone={summary.is_mock ? "demo" : "neutral"}>
        {summary.is_mock
          ? "Synthetic mock"
          : summary.source === "FIXTURE"
            ? "Synthetic fixture"
            : summary.source}
      </Pill>
      <Pill>
        {summary.is_current ? "Current" : "Superseded"} · v{summary.revision}
      </Pill>
    </>
  );
}

export function HistoryCard({ summary, showCompany = false }) {
  return (
    <article className="panel history-card">
      <div className="tags">
        <SummaryLabel summary={summary} />
      </div>
      <h3>
        <Link to={`/summaries/${summary.id}`}>
          {showCompany && `${summary.company} · `}
          {summary.quarter ?? "Quarter unconfirmed"}
        </Link>
      </h3>
      <div className="muted">
        Call <Timestamp value={summary.call_date} onlyDate /> · Published{" "}
        <Timestamp value={summary.published_at} />
      </div>
    </article>
  );
}

/** Render only HTTPS filing links. Fixture URLs are internal identifiers and have no external destination. */
export function SourceLink({ source, url }) {
  if (source === "FIXTURE")
    return <span className="muted">Synthetic source</span>;
  try {
    const link = new URL(url);
    if (
      link.protocol === "https:" &&
      !link.username &&
      !link.password &&
      !link.port
    )
      return (
        <a
          className="button"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open original filing <span className="muted">({source})</span>
        </a>
      );
  } catch {
    /* Unknown or malformed links have no actionable URL. */
  }
  return <span className="muted">Original filing link unverified</span>;
}
