-- Rebuild the provider constraints without losing published summaries, evidence or outbox IDs.
CREATE TEMP TABLE saved_summary_evidence AS SELECT * FROM summary_evidence ORDER BY rowid;
CREATE TEMP TABLE saved_outbox_events AS SELECT * FROM outbox_events ORDER BY rowid;
CREATE TEMP TABLE saved_ai_chunk_cache AS SELECT * FROM ai_chunk_cache ORDER BY rowid;
CREATE TEMP TABLE saved_summaries AS SELECT * FROM summaries ORDER BY rowid;
CREATE TEMP TABLE saved_ai_runs AS SELECT * FROM ai_runs ORDER BY rowid;
CREATE TEMP TABLE saved_outbox_sequence AS SELECT seq FROM sqlite_sequence WHERE name='outbox_events';
DROP TRIGGER evidence_transcript_resize;
DROP TABLE summary_evidence;
DROP TABLE outbox_events;
DROP TABLE ai_chunk_cache;
DROP TABLE summaries;
DROP TABLE ai_runs;

CREATE TABLE summaries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES concall_events (id),
  transcript_id TEXT NOT NULL REFERENCES transcripts (id),
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ai_provider TEXT NOT NULL CHECK (ai_provider IN ('mock', 'gemini', 'extractive')),
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

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY NOT NULL,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id),
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ai_provider TEXT NOT NULL CHECK (ai_provider IN ('mock','gemini','extractive')),
  input_fingerprint TEXT,
  draft_json TEXT CHECK (json_type(draft_json) = 'object'),
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_input_tokens >= 0),
  reported_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reported_input_tokens >= 0),
  reported_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reported_output_tokens >= 0),
  format_repair_used INTEGER NOT NULL DEFAULT 0 CHECK (format_repair_used IN (0,1)),
  synthesis_repair_used INTEGER NOT NULL DEFAULT 0 CHECK (synthesis_repair_used IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (transcript_id, prompt_version, model_id, ai_provider)
) STRICT;

CREATE TABLE ai_chunk_cache (
  run_id TEXT NOT NULL REFERENCES ai_runs(id),
  chunk_hash TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_type(facts_json) = 'object'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, chunk_hash)
) STRICT;

ALTER TABLE summaries ADD COLUMN input_fingerprint TEXT;
ALTER TABLE summaries ADD COLUMN output_fingerprint TEXT;
ALTER TABLE summary_evidence ADD COLUMN source_block_id TEXT;
INSERT INTO ai_runs SELECT * FROM saved_ai_runs ORDER BY rowid;
INSERT INTO summaries SELECT * FROM saved_summaries ORDER BY rowid;
INSERT INTO ai_chunk_cache SELECT * FROM saved_ai_chunk_cache ORDER BY rowid;
INSERT INTO outbox_events SELECT * FROM saved_outbox_events ORDER BY rowid;
INSERT INTO summary_evidence SELECT * FROM saved_summary_evidence ORDER BY rowid;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'outbox_events',seq FROM saved_outbox_sequence WHERE NOT EXISTS
  (SELECT 1 FROM sqlite_sequence WHERE name='outbox_events');
UPDATE sqlite_sequence SET seq=max(seq, (SELECT seq FROM saved_outbox_sequence))
WHERE name='outbox_events' AND EXISTS (SELECT 1 FROM saved_outbox_sequence);
DROP TABLE saved_summary_evidence;
DROP TABLE saved_outbox_events;
DROP TABLE saved_ai_chunk_cache;
DROP TABLE saved_summaries;
DROP TABLE saved_ai_runs;
DROP TABLE saved_outbox_sequence;
