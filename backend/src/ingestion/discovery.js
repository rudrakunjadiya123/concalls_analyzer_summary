import { randomUUID } from "node:crypto";
import { normalizedFilingSchema, rawMetadataSchema } from "@finosauras/shared";
import { parseNormalizedFiling } from "../domain/filing.js";
import { encodeJson } from "../db/queries.js";
import { sha256 } from "../core/hash.js";
import { PipelineError } from "../core/errors.js";
import { classifyFiling } from "./eligibility.js";

export function activeCompanies(db) {
  return db
    .prepare(
      `SELECT id, display_name AS displayName, nse_symbol AS nseSymbol,
    bse_scrip_code AS bseScripCode, isin, identity_verified_at AS identityVerifiedAt
    FROM companies WHERE active = 1 ORDER BY nse_symbol`,
    )
    .all();
}

// Raw key order can vary between polls without representing a real change.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Persist normalized filing observations and their work in the caller's polling transaction. */
export function createDiscoveryRepository(db, logger) {
  const lookup = db.prepare(
    "SELECT * FROM source_filings WHERE source = ? AND source_filing_id = ?",
  );
  const owners =
    db.prepare(`SELECT id, nse_symbol AS nseSymbol, bse_scrip_code AS bseScripCode, isin
    FROM companies WHERE nse_symbol = @nseSymbol
    OR bse_scrip_code = @bseScripCode OR isin = @isin`);
  const addIssuer = db.prepare(`INSERT INTO companies
    (id, display_name, sector, nse_symbol, bse_scrip_code, isin, identity_verified_at, active, created_at, updated_at)
    VALUES (@id, @displayName, 'Unknown', @nseSymbol, @bseScripCode, @isin, @now, 0, @now, @now)`);
  const completeIssuer =
    db.prepare(`UPDATE companies SET nse_symbol = coalesce(nse_symbol, @nseSymbol),
    bse_scrip_code = coalesce(bse_scrip_code, @bseScripCode), isin = coalesce(isin, @isin),
    identity_verified_at = coalesce(identity_verified_at, @now), updated_at = @now
    WHERE id = @id AND (identity_verified_at IS NULL OR (nse_symbol IS NULL AND @nseSymbol IS NOT NULL)
      OR (bse_scrip_code IS NULL AND @bseScripCode IS NOT NULL) OR (isin IS NULL AND @isin IS NOT NULL))`);
  const insertFiling = db.prepare(`INSERT INTO source_filings
    (id, company_id, source, source_filing_id, source_url, originating_exchange, subject, category,
      subcategory, description, attachment_url, filing_published_at, call_date_hint, quarter_hint,
      raw_metadata_json, classification, reason_code, created_at, updated_at, ingestion_fingerprint)
    VALUES (@id, @companyId, @source, @sourceFilingId, @sourceUrl, @exchange, @subject, @category,
      @subcategory, @description, @attachmentUrl, @publishedAt, @callDateHint, @quarterHint,
      @rawJson, @classification, @reason, @now, @now, @fingerprint)
    ON CONFLICT(source, source_filing_id) DO UPDATE SET
      source_url=excluded.source_url, originating_exchange=excluded.originating_exchange,
      subject=excluded.subject, category=excluded.category, subcategory=excluded.subcategory,
      description=excluded.description, attachment_url=excluded.attachment_url, filing_published_at=excluded.filing_published_at,
      call_date_hint=excluded.call_date_hint, quarter_hint=excluded.quarter_hint, raw_metadata_json=excluded.raw_metadata_json,
      classification=excluded.classification, reason_code=excluded.reason_code, updated_at=excluded.updated_at,
      ingestion_fingerprint=excluded.ingestion_fingerprint`);
  const insertObservation =
    db.prepare(`INSERT INTO filing_observations VALUES (?, ?, ?, ?)
    ON CONFLICT(filing_id, fingerprint) DO NOTHING`);
  const insertTarget = db.prepare(`INSERT INTO download_targets
    (id, filing_id, fingerprint, attachment_index, cache_key, url, filename) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (filing_id, fingerprint, attachment_index) DO NOTHING`);
  const discardTarget = db.prepare(
    "UPDATE download_targets SET discarded = 1 WHERE id = ?",
  );
  const priorAttachment = db
    .prepare(
      `SELECT max(t.discarded) FROM download_targets t
    JOIN source_filings f ON f.id = t.filing_id
    JOIN filing_observations o ON o.filing_id = t.filing_id AND o.fingerprint = t.fingerprint
    WHERE t.url = @url AND f.company_id = @companyId
    AND (f.source = @source OR (f.source IN ('NSE','BSE') AND @source IN ('NSE','BSE')))
    AND (@revised = 0 OR json_extract(o.normalized_json, '$.publishedAt') IS @publishedAt)
    `,
    )
    .pluck();
  const insertJob = db.prepare(`INSERT INTO processing_jobs
    (id, job_key, kind, entity_id, step, status, attempts, next_run_at, created_at, updated_at)
    VALUES (?, ?, 'filing_attachment', ?, 'download', 'queued', 0, ?, ?, ?)
    ON CONFLICT (job_key) DO NOTHING`);

  function marketIssuer(filing, existing, now) {
    const identity = filing.company;
    const [match, conflict] = owners.all(identity);
    const conflictingCode =
      match &&
      ["nseSymbol", "bseScripCode", "isin"].some(
        (key) => match[key] && identity[key] && match[key] !== identity[key],
      );
    if (
      conflict ||
      conflictingCode ||
      (existing && existing.company_id !== match?.id)
    ) {
      logger?.warn("market_company_conflict", {
        stage: "source",
        source: filing.source,
        error_code: "COMPANY_IDENTITY_CONFLICT",
      });
      return null;
    }
    // An authorized filing supplies stable identity. Newly found issuers stay off the saved watchlist.
    const id = match?.id ?? randomUUID();
    (match ? completeIssuer : addIssuer).run({ ...identity, id, now });
    return id;
  }

  return function save(
    records,
    company,
    adapter,
    now,
    { admit, onQueued } = {},
  ) {
    const identity = company && {
      displayName: company.displayName,
      nseSymbol: company.nseSymbol,
      bseScripCode: company.bseScripCode,
      isin: company.isin,
    };
    let queued = 0;
    for (const record of records) {
      const filing = parseNormalizedFiling(record, identity);
      if (filing.source !== adapter.source)
        throw new PipelineError("COMPANY_IDENTITY_CONFLICT");
      const existing = lookup.get(filing.source, filing.sourceFilingId);
      const id = existing?.id ?? randomUUID();
      const fingerprint = sha256(stableJson(filing));
      const { classification, reason, revised, targets } = classifyFiling(
        filing,
        adapter.allowedAttachment,
      );
      if (
        company &&
        (owners.all(filing.company).some(({ id }) => id !== company.id) ||
          (existing && existing.company_id !== company.id))
      )
        throw new PipelineError("COMPANY_IDENTITY_CONFLICT");
      if (!company && (!targets.length || filing.raw.synthetic === true))
        continue;
      const companyId = company?.id ?? marketIssuer(filing, existing, now);
      if (!companyId) continue;
      const params = {
        ...filing,
        id,
        companyId,
        now,
        classification,
        reason,
        fingerprint,
        exchange:
          filing.originatingExchange ??
          (["NSE", "BSE"].includes(filing.source) ? filing.source : null),
        attachmentUrl: targets[0]?.url ?? filing.attachments[0]?.url ?? null,
        rawJson: encodeJson(rawMetadataSchema, filing.raw),
      };
      if (!existing) insertFiling.run(params);
      const fresh = insertObservation.run(
        id,
        fingerprint,
        encodeJson(normalizedFilingSchema, filing),
        now,
      ).changes;
      if (!fresh) continue;
      // An overlap/backfill can surface an older observation without replacing current metadata.
      const updateCurrent =
        fresh &&
        existing &&
        (!existing.filing_published_at ||
          (filing.publishedAt &&
            filing.publishedAt >= existing.filing_published_at));
      if (updateCurrent && (!admit || !targets.length))
        insertFiling.run(params);
      let newCandidate = false;
      for (const target of targets) {
        const targetId = randomUUID();
        // Compare known URLs before recording this observation's targets. A later correction
        // can replace the bytes at the same URL and is eligible as a separate upload.
        const prior = priorAttachment.get({
          url: target.url,
          companyId,
          source: filing.source,
          revised: Number(revised),
          publishedAt: filing.publishedAt,
        });
        // A changed observation or explicit correction can replace bytes at the same URL.
        const version = existing || revised ? fingerprint : "initial";
        const cacheKey = sha256(
          JSON.stringify([adapter.cacheNamespace, target.url, version]),
        );
        const inserted = insertTarget.run(
          targetId,
          id,
          fingerprint,
          target.index,
          cacheKey,
          target.url,
          target.filename,
        ).changes;
        if (!inserted) continue;
        if (admit) {
          // Count one candidate per filing and discard additional attachments or unselected filings.
          const first = prior === null && !newCandidate;
          newCandidate ||= first;
          if (!first || !admit(targetId)) {
            discardTarget.run(targetId);
            continue;
          }
        } else if (prior === 1) {
          // A changed provider observation must not put a discarded URL back into the pipeline.
          discardTarget.run(targetId);
          continue;
        }
        const job = insertJob.run(
          randomUUID(),
          `download:${targetId}`,
          targetId,
          now,
          now,
          now,
        );
        if (job.changes) {
          queued++;
          onQueued?.(filing.source, targetId);
        }
      }
      // Provider metadata changes alone should not reset a previously reviewed attachment.
      if (admit && updateCurrent && newCandidate) insertFiling.run(params);
    }
    return queued;
  };
}
