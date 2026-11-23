-- A feed's metadata cannot grant a locally imported PDF permission to use Gemini.
CREATE TABLE local_pdf_imports (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES document_sources(id),
  gemini_allowed INTEGER NOT NULL CHECK (gemini_allowed IN (0, 1))
) STRICT;
