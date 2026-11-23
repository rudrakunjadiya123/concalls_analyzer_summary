-- A fiscal convention must be explicitly verified before inferring quarter labels from period ends.
ALTER TABLE companies ADD COLUMN fiscal_year_start_month INTEGER CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

CREATE TABLE pdf_extractions (
  document_id TEXT PRIMARY KEY REFERENCES documents(id),
  extraction_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('extracted', 'failed')),
  page_count INTEGER CHECK (page_count > 0),
  clean_text_sha256 TEXT,
  page_map_path TEXT,
  quality_json TEXT CHECK (json_type(quality_json) = 'object'),
  error_code TEXT,
  updated_at TEXT NOT NULL
) STRICT;

-- Link each validated PDF to the exact filing observation, including replacements at the same URL.
CREATE TABLE document_sources (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  filing_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  FOREIGN KEY (filing_id, document_id) REFERENCES filing_documents(filing_id, document_id),
  UNIQUE (document_id, filing_id, fingerprint)
) STRICT;
CREATE INDEX document_sources_filing ON document_sources(filing_id, fingerprint);

CREATE TABLE document_reviews (
  source_id TEXT PRIMARY KEY REFERENCES document_sources(id),
  classification TEXT NOT NULL CHECK (classification IN ('confirmed_transcript', 'excluded', 'needs_document', 'unsupported')),
  role TEXT NOT NULL CHECK (role IN ('transcript', 'cover_letter', 'other', 'unknown')),
  reason_code TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  decision TEXT NOT NULL,
  transcript_id TEXT REFERENCES transcripts(id),
  metadata_json TEXT NOT NULL CHECK (json_type(metadata_json) = 'object'),
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX document_reviews_status ON document_reviews(classification, decision, reason_code);
CREATE INDEX document_reviews_transcript ON document_reviews(transcript_id);

CREATE TABLE transcript_documents (
  document_id TEXT PRIMARY KEY REFERENCES documents(id),
  transcript_id TEXT NOT NULL REFERENCES transcripts(id),
  relation TEXT NOT NULL CHECK (relation IN ('original', 'duplicate_text')),
  linked_at TEXT NOT NULL
) STRICT;
CREATE INDEX transcript_documents_transcript ON transcript_documents(transcript_id);

CREATE INDEX concall_event_title_date ON concall_events(company_id, normalized_title, call_date);
CREATE INDEX processing_jobs_due_step ON processing_jobs(step, status, next_run_at);
