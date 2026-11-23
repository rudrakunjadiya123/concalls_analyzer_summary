import { normalizedFilingSchema, rawMetadataSchema } from "@finosauras/shared";
import { sourceGrants } from "../config/env.js";
import { PipelineError } from "../core/errors.js";
import { parseSourceUrl } from "../core/security.js";
import { decodeJson } from "../db/queries.js";
import { trustedSchema } from "../ai/contracts.js";

function safeSource(value) {
  try {
    const url = parseSourceUrl(value);
    // Signed download URLs are private transport references, not public provenance links.
    if (
      [...url.searchParams.keys()].some((key) =>
        /(?:token|signature|secret|password|api[-_]?key|credential|^x-(?:amz|goog)-)/iu.test(
          key,
        ),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function official({ source, source_url: value }) {
  if (!value) return false;
  const domain =
    source === "NSE"
      ? /(?:^|\.)nseindia\.(?:com|in)$/u
      : source === "BSE"
        ? /(?:^|\.)bseindia\.com$/u
        : /\.invalid$/u;
  return domain.test(new URL(value).hostname);
}

const orderedDate = (row) => row.filing_published_at ?? "9999";
const restricted = () => new PipelineError("AI_PROVIDER_RESTRICTED");

/** Resolve the canonical PDF and source metadata from confirmed, immutable filing observations. */
export function summaryContext(db, transcriptId, config, provider) {
  const row = db
    .prepare(
      `SELECT t.*, e.id AS event_id, e.current_transcript_id, v.version_number, v.revision_kind,
    c.display_name, c.nse_symbol, c.bse_scrip_code, c.identity_verified_at, d.sha256, d.storage_relative_path
    FROM transcripts t JOIN documents d ON d.id=t.document_id JOIN companies c ON c.id=t.company_id
    JOIN event_transcripts v ON v.transcript_id=t.id JOIN concall_events e ON e.id=v.event_id WHERE t.id=?`,
    )
    .get(transcriptId);
  if (!row) throw new PipelineError("NOT_FOUND");
  if (row.revision_kind === "unknown")
    throw new PipelineError("AI_STALE_REVISION");
  const linked = db
    .prepare(
      `SELECT f.id AS filing_id, s.document_id, f.source, f.originating_exchange,
    f.source_url, f.filing_published_at, f.raw_metadata_json, o.normalized_json, r.metadata_json,
    i.gemini_allowed
    FROM document_reviews r JOIN document_sources s ON s.id=r.source_id JOIN source_filings f ON f.id=s.filing_id
    LEFT JOIN filing_observations o ON o.filing_id=f.id AND o.fingerprint=s.fingerprint
    LEFT JOIN local_pdf_imports i ON i.source_id=s.id
    WHERE r.transcript_id=? AND r.classification='confirmed_transcript'`,
    )
    .all(transcriptId);
  const grants = sourceGrants(config);
  const fixture = config.DATA_MODE === "fixture";
  const candidates = linked.flatMap((item) => {
    const snapshot = item.normalized_json
      ? decodeJson(normalizedFilingSchema, item.normalized_json)
      : null;
    const source = snapshot?.source ?? item.source;
    const raw =
      snapshot?.raw ?? decodeJson(rawMetadataSchema, item.raw_metadata_json);
    if (
      fixture
        ? source !== "FIXTURE" || raw.synthetic !== true
        : source === "FIXTURE" || raw.synthetic === true
    )
      return [];
    const review = JSON.parse(item.metadata_json);
    const unlinkedArchive =
      item.gemini_allowed !== null &&
      raw.acquisition === "local_pdf" &&
      raw.originalExchangeUrlUnverified === true;
    return [
      {
        source:
          snapshot?.originatingExchange ?? item.originating_exchange ?? source,
        // Local consent is recorded by the CLI transaction, independently of remote feed grants.
        authorized:
          item.gemini_allowed === null
            ? grants[source]
            : provider.id === "extractive" || item.gemini_allowed === 1,
        filing_id: item.filing_id,
        document_id: item.document_id,
        source_url: unlinkedArchive
          ? null
          : safeSource(snapshot?.sourceUrl ?? item.source_url),
        filing_published_at: snapshot
          ? snapshot.publishedAt
          : item.filing_published_at,
        warnings: [
          ...(review.warnings ?? []),
          ...(unlinkedArchive
            ? ["original_exchange_attachment_url_unverified"]
            : []),
        ],
        callDate: review.call_date,
        quarter: review.quarter,
      },
    ];
  });
  if (
    !candidates.length ||
    (!fixture &&
      (provider.isMock ||
        !row.identity_verified_at ||
        !candidates.some(
          ({ authorized, document_id }) =>
            authorized && document_id === row.document_id,
        )))
  )
    throw restricted();
  const sorted = candidates.sort(
    (a, b) =>
      Number(b.document_id === row.document_id) -
        Number(a.document_id === row.document_id) ||
      Number(official(b)) - Number(official(a)) ||
      orderedDate(a).localeCompare(orderedDate(b)) ||
      a.filing_id.localeCompare(b.filing_id) ||
      (a.source_url ?? "").localeCompare(b.source_url ?? ""),
  );
  const primary = sorted[0];
  if (primary.document_id !== row.document_id) throw restricted();
  const sources = [
    ...new Map(
      sorted.map(
        ({
          source,
          filing_id,
          document_id,
          source_url,
          filing_published_at,
        }) => {
          const reference = {
            source,
            filing_id,
            document_id,
            source_url,
            filing_published_at,
          };
          return [JSON.stringify(reference), reference];
        },
      ),
    ).values(),
  ];
  const warnings = new Set(sorted.flatMap((item) => item.warnings));
  if (new Set(sorted.map(({ callDate }) => callDate).filter(Boolean)).size > 1)
    warnings.add("call_date_conflict");
  if (new Set(sorted.map(({ quarter }) => quarter).filter(Boolean)).size > 1)
    warnings.add("quarter_conflict");
  const hasDateConflict = warnings.has("call_date_conflict");
  const hasQuarterConflict = warnings.has("quarter_conflict");
  const call_date = hasDateConflict ? null : row.detected_call_date;
  const quarter = hasQuarterConflict ? null : row.detected_quarter;
  if (!call_date) warnings.add("call_date_unconfirmed");
  if (!quarter) warnings.add("quarter_unconfirmed");
  return {
    row,
    document: {
      id: row.document_id,
      sha256: row.sha256,
      storage_relative_path: row.storage_relative_path,
    },
    trusted: trustedSchema.parse({
      metadata: {
        company: fixture ? "Synthetic Test Company" : row.display_name,
        scrip_code: fixture ? null : row.bse_scrip_code,
        nse_symbol: fixture ? null : row.nse_symbol,
        quarter,
        call_date,
        source: primary.source,
        source_url: primary.source_url,
      },
      warnings: [...warnings].sort(),
      dataMode: config.DATA_MODE,
      sources,
    }),
  };
}
