-- Durable, source-wide policy holds survive both process restarts and manual CLI runs.
ALTER TABLE source_health ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1));
ALTER TABLE source_health ADD COLUMN paused_until TEXT;
ALTER TABLE source_filings ADD COLUMN ingestion_fingerprint TEXT;

CREATE TABLE scheduler_leases (
  name TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- A later observation can add another target without deleting an earlier observation or PDF.
CREATE TABLE filing_observations (
  filing_id TEXT NOT NULL REFERENCES source_filings(id),
  fingerprint TEXT NOT NULL,
  normalized_json TEXT NOT NULL CHECK (json_type(normalized_json) = 'object'),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (filing_id, fingerprint)
) STRICT;

CREATE TABLE download_targets (
  id TEXT PRIMARY KEY NOT NULL,
  filing_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  attachment_index INTEGER NOT NULL CHECK (attachment_index >= 0),
  cache_key TEXT NOT NULL,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  FOREIGN KEY (filing_id, fingerprint) REFERENCES filing_observations(filing_id, fingerprint),
  UNIQUE (filing_id, fingerprint, attachment_index)
) STRICT;

CREATE TABLE download_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id)
) STRICT;
