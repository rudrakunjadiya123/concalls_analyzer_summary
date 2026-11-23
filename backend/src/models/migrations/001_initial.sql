-- The migration runner applies this file and records its version in one transaction.
CREATE TABLE companies (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  sector TEXT NOT NULL,
  nse_symbol TEXT UNIQUE,
  bse_scrip_code TEXT UNIQUE,
  isin TEXT UNIQUE,
  identity_verified_at TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX companies_active_sector ON companies (active, sector);

CREATE TABLE source_filings (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies (id),
  source TEXT NOT NULL CHECK (source IN ('NSE', 'BSE', 'LICENSED', 'FIXTURE')),
  source_filing_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  originating_exchange TEXT CHECK (originating_exchange IN ('NSE', 'BSE')),
  subject TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  description TEXT NOT NULL,
  attachment_url TEXT,
  filing_published_at TEXT,
  call_date_hint TEXT,
  quarter_hint TEXT,
  raw_metadata_json TEXT NOT NULL CHECK (json_type(raw_metadata_json) = 'object'),
  classification TEXT NOT NULL CHECK (classification IN ('candidate', 'excluded', 'needs_document', 'confirmed_transcript', 'unsupported')),
  reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_filing_id)
) STRICT;
CREATE INDEX source_filings_company_date ON source_filings (company_id, filing_published_at DESC);
CREATE INDEX source_filings_classification ON source_filings (classification, updated_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  storage_relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  original_name TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  downloaded_at TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  notes_json TEXT NOT NULL CHECK (json_valid(notes_json))
) STRICT;
CREATE INDEX documents_validation_status ON documents (validation_status);

CREATE TABLE filing_documents (
  filing_id TEXT NOT NULL REFERENCES source_filings (id),
  document_id TEXT NOT NULL REFERENCES documents (id),
  attachment_index INTEGER NOT NULL CHECK (attachment_index >= 0),
  role TEXT NOT NULL CHECK (role IN ('transcript', 'cover_letter', 'other', 'unknown')),
  PRIMARY KEY (filing_id, document_id)
) STRICT;
CREATE INDEX filing_documents_document ON filing_documents (document_id, role);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL UNIQUE REFERENCES documents (id),
  company_id TEXT NOT NULL REFERENCES companies (id),
  extraction_version TEXT NOT NULL,
  raw_text_path TEXT NOT NULL,
  clean_text_path TEXT NOT NULL,
  page_map_path TEXT NOT NULL,
  clean_text_sha256 TEXT NOT NULL CHECK (length(clean_text_sha256) = 64 AND clean_text_sha256 NOT GLOB '*[^0-9a-f]*'),
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  character_count INTEGER NOT NULL CHECK (character_count >= 0),
  extraction_quality_json TEXT NOT NULL CHECK (json_type(extraction_quality_json) = 'object'),
  transcript_confidence TEXT NOT NULL,
  language TEXT,
  detected_call_date TEXT,
  detected_quarter TEXT,
  period_end TEXT,
  stage_status TEXT NOT NULL CHECK (stage_status IN ('downloaded', 'extracted', 'classified', 'facts_extracted', 'validated', 'published', 'needs_review', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX transcripts_company_text_hash ON transcripts (company_id, clean_text_sha256);
CREATE INDEX transcripts_stage_status ON transcripts (stage_status, updated_at);

CREATE TABLE concall_events (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies (id),
  call_date TEXT,
  quarter TEXT,
  period_end TEXT,
  normalized_title TEXT NOT NULL,
  event_identity_key TEXT NOT NULL,
  current_transcript_id TEXT REFERENCES transcripts (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, event_identity_key),
  FOREIGN KEY (id, current_transcript_id) REFERENCES event_transcripts (event_id, transcript_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX concall_events_company_call_date ON concall_events (company_id, call_date DESC);
CREATE INDEX concall_events_current_transcript ON concall_events (current_transcript_id);

CREATE TABLE event_transcripts (
  event_id TEXT NOT NULL REFERENCES concall_events (id),
  transcript_id TEXT NOT NULL UNIQUE REFERENCES transcripts (id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('original', 'correction', 'duplicate_text', 'unknown')),
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  linked_at TEXT NOT NULL,
  PRIMARY KEY (event_id, version_number),
  UNIQUE (event_id, transcript_id)
) STRICT;
CREATE UNIQUE INDEX event_transcripts_one_current ON event_transcripts (event_id) WHERE is_current = 1;

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  job_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('download', 'extract', 'classify', 'summarize', 'verify_publish')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'completed', 'dead')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
) STRICT;
CREATE INDEX processing_jobs_due ON processing_jobs (status, next_run_at);
CREATE INDEX processing_jobs_lease ON processing_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX processing_jobs_entity ON processing_jobs (entity_id, step);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES concall_events (id),
  transcript_id TEXT NOT NULL REFERENCES transcripts (id),
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ai_provider TEXT NOT NULL CHECK (ai_provider IN ('mock', 'gemini')),
  is_mock INTEGER NOT NULL CHECK (is_mock IN (0, 1)),
  json_payload TEXT NOT NULL CHECK (json_type(json_payload) = 'object'),
  markdown_payload TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  validation_report_json TEXT NOT NULL CHECK (json_type(validation_report_json) = 'object'),
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL,
  published_at TEXT,
  CHECK ((ai_provider = 'mock') = is_mock),
  UNIQUE (transcript_id, prompt_version, model_id, ai_provider),
  FOREIGN KEY (event_id, transcript_id) REFERENCES event_transcripts (event_id, transcript_id)
) STRICT;
CREATE UNIQUE INDEX summaries_one_current ON summaries (event_id) WHERE is_current = 1;
CREATE INDEX summaries_event_published ON summaries (event_id, published_at DESC, id);
CREATE INDEX summaries_published ON summaries (published_at DESC, id);
CREATE INDEX summaries_validation ON summaries (validation_status);

CREATE TABLE summary_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  summary_id TEXT NOT NULL REFERENCES summaries (id),
  claim_path TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number >= 1),
  speaker TEXT,
  supporting_quote TEXT NOT NULL,
  supporting_quote_hash TEXT NOT NULL CHECK (length(supporting_quote_hash) = 64 AND supporting_quote_hash NOT GLOB '*[^0-9a-f]*'),
  verification_status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX summary_evidence_claim ON summary_evidence (summary_id, claim_path);
CREATE INDEX summary_evidence_verification ON summary_evidence (verification_status);

-- A CHECK cannot read another table. These triggers guard page references across both write paths.
CREATE TRIGGER evidence_page_insert BEFORE INSERT ON summary_evidence
WHEN NEW.page_number > (
  SELECT t.page_count FROM summaries s JOIN transcripts t ON t.id = s.transcript_id
  WHERE s.id = NEW.summary_id
)
BEGIN
  SELECT RAISE(ABORT, 'Evidence page exceeds transcript page count');
END;

CREATE TRIGGER evidence_page_update BEFORE UPDATE OF page_number, summary_id ON summary_evidence
WHEN NEW.page_number > (
  SELECT t.page_count FROM summaries s JOIN transcripts t ON t.id = s.transcript_id
  WHERE s.id = NEW.summary_id
)
BEGIN
  SELECT RAISE(ABORT, 'Evidence page exceeds transcript page count');
END;

CREATE TRIGGER evidence_transcript_resize BEFORE UPDATE OF page_count ON transcripts
WHEN EXISTS (
  SELECT 1 FROM summaries s JOIN summary_evidence e ON e.summary_id = s.id
  WHERE s.transcript_id = OLD.id AND e.page_number > NEW.page_count
)
BEGIN
  SELECT RAISE(ABORT, 'Transcript page count would invalidate existing evidence');
END;

CREATE TRIGGER summary_keep_transcript BEFORE UPDATE OF transcript_id ON summaries
WHEN OLD.transcript_id <> NEW.transcript_id
BEGIN
  SELECT RAISE(ABORT, 'A summary cannot change its transcript version');
END;

CREATE TABLE outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('summary.created', 'summary.updated')),
  summary_id TEXT NOT NULL REFERENCES summaries (id),
  payload_json TEXT NOT NULL CHECK (json_type(payload_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (summary_id, type)
) STRICT;
CREATE INDEX outbox_events_type_id ON outbox_events (type, id);

CREATE TABLE poll_cursors (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('NSE', 'BSE', 'LICENSED', 'FIXTURE')),
  watchlist_partition TEXT NOT NULL,
  last_successful_window_end TEXT,
  last_poll_started_at TEXT,
  last_poll_completed_at TEXT,
  last_result TEXT CHECK (last_result IN ('success', 'incomplete', 'blocked', 'error', 'disabled')),
  last_error_code TEXT,
  next_allowed_poll_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source, watchlist_partition)
) STRICT;
CREATE INDEX poll_cursors_result_next ON poll_cursors (last_result, next_allowed_poll_at);

CREATE TABLE source_health (
  source TEXT PRIMARY KEY NOT NULL CHECK (source IN ('NSE', 'BSE', 'LICENSED', 'FIXTURE')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('authorized', 'fixture', 'disabled_permission')),
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error_code TEXT,
  latency_ms INTEGER CHECK (latency_ms >= 0),
  documents_discovered INTEGER CHECK (documents_discovered >= 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX source_health_access_mode ON source_health (access_mode);
