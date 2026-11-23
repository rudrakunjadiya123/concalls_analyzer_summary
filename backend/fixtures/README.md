# Synthetic ingestion fixtures

The exchange JSON files are authored contract examples based on the field hypotheses in the master spec. They contain no captured exchange responses. Scrip 500209 and symbol INFY route test rows to an existing watchlist slot. The announcements and PDF content are fictional. All example source domains end in .invalid.

Run the fixture generator with node backend/scripts/generate-stage2-fixtures.js. One PDF has fictional dialogue. The other contains only a fictional cover letter. Stage 2 validates both PDF containers and leaves actual transcript classification to Stage 3.

Generate the Stage 3 layouts with `node backend/scripts/generate-stage3-fixtures.js`. The set includes a two-page fictional transcript with a numeric table, Unicode rupee/minus glyphs and a question split across pages. It also includes scrambled two-column reading order, a 42-page document, an image-only page, a blank page, an audio notice and a deliberately malformed container. The Stage 3 tests create additional fictional revisions and whitespace-equivalent wrappers from the same deterministic generator.

`node backend/scripts/generate-stage4-fixtures.js` generates the current mock smoke transcript. Its fictional numbers exercise consolidated and standalone figures, reporting periods, guidance, a cross-page Q&A, risks and an instruction embedded as source text. It contains no actual company results.

`node backend/scripts/generate-stage5-fixtures.js` generates the fictional replay call and its corrected revenue figure. Both run through the production queue and carry synthetic provenance.
