-- Keep provider work separate from public artifacts and retain retry checkpoints.
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY NOT NULL,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id),
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  ai_provider TEXT NOT NULL CHECK (ai_provider IN ('mock','gemini')),
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

CREATE INDEX ai_jobs_due ON processing_jobs(step, status, next_run_at)
  WHERE step IN ('summarize', 'verify_publish');
CREATE TABLE ai_provider_holds (
  ai_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  resume_at TEXT NOT NULL,
  PRIMARY KEY (ai_provider, model_id)
) STRICT;
ALTER TABLE summaries ADD COLUMN input_fingerprint TEXT;
ALTER TABLE summaries ADD COLUMN output_fingerprint TEXT;
ALTER TABLE summary_evidence ADD COLUMN source_block_id TEXT;
