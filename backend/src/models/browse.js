import { summarySchema } from "@finosauras/shared";
import { decodeJson } from "./queries.js";
import { latestEventId } from "./outbox.js";
import { PipelineError } from "../utils/errors.js";
import { systemClock } from "../utils/clock.js";

const missing = () =>
  new PipelineError("NOT_FOUND", undefined, { statusCode: 404 });

// Scope both history and replay by the mode saved at publication. A database can contain multiple modes.
const published = `FROM summaries s JOIN outbox_events o ON o.summary_id=s.id
  JOIN event_transcripts v ON v.transcript_id=s.transcript_id JOIN concall_events e ON e.id=s.event_id
  WHERE s.published_at IS NOT NULL AND s.validation_status='passed'
    AND json_extract(o.payload_json,'$.data_mode')=@mode`;
const fields = `s.id,e.company_id,s.event_id AS concall_event_id,v.version_number AS revision,s.is_current,s.is_mock,
  s.published_at,s.model_id,s.prompt_version,
  json_extract(s.json_payload,'$.company') AS company,json_extract(s.json_payload,'$.quarter') AS quarter,
  json_extract(s.json_payload,'$.call_date') AS call_date,json_extract(s.json_payload,'$.source') AS source`;
const card = (row) => ({
  ...row,
  is_mock: Boolean(row.is_mock),
  is_current: Boolean(row.is_current),
  status: "published",
});
/** Read published state without exposing raw documents or private storage paths. */
export function createBrowseModel({
  db,
  mode,
  clock = systemClock,
  ingestionStatus,
  wsStatus = () => 0,
}) {
  const latestSummary = `SELECT ${fields} ${published} AND s.is_current=1 AND e.company_id=@id
    ORDER BY (json_extract(s.json_payload,'$.call_date') IS NULL), json_extract(s.json_payload,'$.call_date') DESC,
      json_extract(s.validation_report_json,'$.sources[0].filing_published_at') DESC,s.published_at DESC,s.id DESC LIMIT 1`;
  const companyFields =
    "id,display_name,sector,nse_symbol,bse_scrip_code,isin,identity_verified_at,active";
  const companyById = (id) =>
    db.prepare(`SELECT ${companyFields} FROM companies WHERE id=?`).get(id);

  function companyCard(row) {
    const recent = db.prepare(latestSummary).get({ mode, id: row.id });
    const sourceRows = db
      .prepare(
        `SELECT DISTINCT f.source,f.classification,EXISTS (
          SELECT 1 FROM download_targets t JOIN processing_jobs j ON j.entity_id=t.id
          WHERE t.filing_id=f.id AND t.fingerprint=f.ingestion_fingerprint
            AND j.step='download' AND j.status<>'dead'
        ) AS selected, EXISTS (
          SELECT 1 FROM download_targets t WHERE t.filing_id=f.id
            AND t.fingerprint=f.ingestion_fingerprint AND t.discarded=1
        ) AS discarded FROM source_filings f
      WHERE f.company_id=? AND ((?='fixture' AND f.source='FIXTURE')
      OR (?='licensed-feed' AND f.source='LICENSED') OR (?='authorized-direct' AND f.source IN ('NSE','BSE')))`,
      )
      .all(row.id, mode, mode, mode);
    const latest = recent ? card(recent) : null;
    const sources = latest
      ? (validationReport(latest.id).sources ?? []).map(({ source }) => source)
      : [];
    const age = latest?.call_date
      ? Math.max(
          0,
          Math.floor(
            (clock.now().getTime() - Date.parse(latest.call_date)) / 86_400_000,
          ),
        )
      : null;
    return {
      ...row,
      active: Boolean(row.active),
      identity_verified: Boolean(row.identity_verified_at),
      source_availability: [
        ...new Set(
          sources.length ? sources : sourceRows.map(({ source }) => source),
        ),
      ],
      last_known_transcript_age_days: age,
      latest_summary: latest,
      status: latest
        ? "published"
        : sourceRows.some(
              ({ classification }) => classification === "needs_document",
            )
          ? "needs_document"
          : sourceRows.some(
                ({ classification, selected }) =>
                  classification === "confirmed_transcript" ||
                  (classification === "candidate" && selected),
              )
            ? "processing"
            : sourceRows.some(
                  ({ classification, discarded }) =>
                    classification === "candidate" && discarded,
                )
              ? "skipped"
              : "not_available",
    };
  }

  function validationReport(id) {
    return JSON.parse(
      db
        .prepare("SELECT validation_report_json FROM summaries WHERE id=?")
        .pluck()
        .get(id),
    );
  }

  function detail(id) {
    const row = db
      .prepare(
        `SELECT ${fields},s.json_payload,s.markdown_payload ${published} AND s.id=@id`,
      )
      .get({ mode, id });
    if (!row) throw missing();
    const {
      json_payload,
      markdown_payload,
      id: summaryId,
      company_id,
      concall_event_id,
      revision,
      is_current,
      is_mock,
      published_at,
      model_id,
      prompt_version,
    } = row;
    const report = validationReport(id);
    return {
      ...card({
        id: summaryId,
        company_id,
        concall_event_id,
        revision,
        is_current,
        is_mock,
        published_at,
        model_id,
        prompt_version,
      }),
      json: decodeJson(summarySchema, json_payload),
      markdown: markdown_payload,
      sources: (report.sources ?? []).map(
        ({ source, source_url, filing_published_at }) => ({
          source,
          source_url,
          filing_published_at,
        }),
      ),
      validation: {
        status: "passed",
        warnings: report.warnings ?? [],
        evidence_count: report.evidence_count ?? 0,
      },
    };
  }

  function requireCompany(id) {
    const row = companyById(id);
    if (!row) throw missing();
    return row;
  }

  function status() {
    const status = ingestionStatus?.() ?? {};
    const counts = db
      .prepare(
        `SELECT count(*) AS total,count(DISTINCT e.company_id) AS companies ${published}`,
      )
      .get({ mode });
    const jobs = db
      .prepare(
        "SELECT status,count(*) AS count FROM processing_jobs GROUP BY status",
      )
      .all();
    const countsByStatus = Object.fromEntries(
      jobs.map((job) => [job.status, job.count]),
    );
    const sources = Object.fromEntries(
      Object.entries(status.sources ?? {}).map(([key, value]) => {
        const last = db
          .prepare(
            `SELECT max(last_poll_started_at) AS started,max(last_poll_completed_at) AS completed
        FROM poll_cursors WHERE source=?`,
          )
          .get(key);
        return [
          key,
          {
            ...value,
            authorized: value.enabled && value.mode === "authorized",
            last_poll_started_at: last.started,
            last_poll_completed_at: last.completed,
          },
        ];
      }),
    );
    return {
      ...status,
      data_mode: mode,
      sources,
      published_summaries: counts.total,
      processed_companies: counts.companies,
      jobs: {
        completed: countsByStatus.completed ?? 0,
        retry_wait: countsByStatus.retry_wait ?? 0,
        dead: countsByStatus.dead ?? 0,
      },
      ws_clients: wsStatus(),
      last_event_id: latestEventId(db, mode),
    };
  }

  function watchlist() {
    return db
      .prepare(
        `SELECT ${companyFields} FROM companies WHERE active=1 ORDER BY display_name COLLATE NOCASE,id`,
      )
      .all()
      .map(companyCard);
  }

  function companies({ sector, key, after, size }) {
    return db
      .prepare(
        `SELECT ${companyFields} FROM companies WHERE active=1 AND (@sector IS NULL OR sector=@sector COLLATE NOCASE)
      AND (@key IS NULL OR (display_name COLLATE NOCASE,id)>(@key,@after))
      ORDER BY display_name COLLATE NOCASE,id LIMIT @size`,
      )
      .all({
        sector: sector ?? null,
        key,
        after,
        size,
      });
  }

  function company(id) {
    const value = companyCard(requireCompany(id));
    return {
      ...value,
      latest_event: value.latest_summary
        ? {
            id: value.latest_summary.concall_event_id,
            call_date: value.latest_summary.call_date,
            quarter: value.latest_summary.quarter,
          }
        : null,
    };
  }

  function history({ companyId, includeHistory, key, after, size }) {
    return db
      .prepare(
        `SELECT ${fields} ${published}
      AND (@company IS NULL OR e.company_id=@company) AND (@history=1 OR s.is_current=1)
      AND (@key IS NULL OR (s.published_at,s.id)<(@key,@after))
      ORDER BY s.published_at DESC,s.id DESC LIMIT @size`,
      )
      .all({
        mode,
        company: companyId ?? null,
        history: Number(includeHistory),
        key,
        after,
        size,
      })
      .map(card);
  }

  function evidence(id) {
    detail(id);
    return db
      .prepare(
        `SELECT claim_path,page_number,speaker,supporting_quote,verification_status,source_block_id
      FROM summary_evidence WHERE summary_id=? ORDER BY claim_path,page_number,id`,
      )
      .all(id);
  }

  return {
    status,
    watchlist,
    companies,
    companyCard,
    company,
    requireCompany,
    history,
    detail,
    evidence,
  };
}
