import { PipelineError } from "../../utils/errors.js";
import { createLocalPdfSource } from "../sources/local-pdf.js";
import { createDiscoveryRepository } from "./discovery.js";
import { downloadDocument } from "./download.js";
import { utcIso } from "../../utils/clock.js";
import { readPrivateFile } from "../../utils/storage.js";
import { withPdf } from "../pdf/document.js";

/** Import one local attachment without advancing exchange polling checkpoints. */
export async function importLocalPdf({
  db,
  jobs,
  config,
  clock,
  signal,
  input,
}) {
  if (config.DATA_MODE === "fixture" || !input.authorized)
    throw new PipelineError("SOURCE_NOT_AUTHORIZED");
  if (input.summarize && config.AI_PROVIDER !== "gemini")
    throw new PipelineError("AI_PROVIDER_RESTRICTED");
  const adapter = createLocalPdfSource(
    input.filePath,
    input.sourceUrl,
    input.archiveExchange,
  );
  const company = db
    .prepare(
      `SELECT id, display_name AS displayName, nse_symbol AS nseSymbol,
      bse_scrip_code AS bseScripCode, isin FROM companies
      WHERE (nse_symbol = ? OR bse_scrip_code = ?) AND identity_verified_at IS NOT NULL`,
    )
    .get(input.company ?? "", input.company ?? "");
  if (
    !company ||
    !(adapter.source === "NSE" ? company.nseSymbol : company.bseScripCode)
  )
    throw new PipelineError("UNVERIFIED_COMPANY");
  const { id, ...identity } = company;
  // Validate the supplied metadata before allocating private PDF storage.
  adapter.filing(identity, input, "");
  const artifact = await downloadDocument(adapter, adapter.url, config, signal);
  if (input.archiveExchange) {
    const bytes = await readPrivateFile(
      config.DATA_DIR,
      artifact.storageRelativePath,
      {
        maxBytes: config.MAX_DOWNLOAD_BYTES,
        signal,
      },
    );
    const cover = await withPdf(
      bytes,
      { signal, maxPages: config.MAX_PDF_PAGES },
      async (pdf) => {
        const page = await pdf.getPage(1);
        const content = await page.getTextContent();
        return content.items.map((item) => item.str ?? "").join(" ");
      },
    );
    const exchangeName =
      input.archiveExchange === "NSE"
        ? /\bnational\s+stock\s+exchange\b/iu
        : /\b(?:bse\s+(?:limited|ltd)|bombay\s+stock\s+exchange)\b/iu;
    if (!exchangeName.test(cover))
      throw new PipelineError("UNVERIFIED_COMPANY");
  }
  signal?.throwIfAborted();
  const filing = adapter.filing(identity, input, artifact.sha256);
  const save = createDiscoveryRepository(db);
  return db
    .transaction(() => {
      const now = utcIso(clock.now());
      save([filing], { id, ...identity }, adapter, now, {
        onQueued(source, targetId) {
          // Complete this exact download job inside the filing transaction. Recovery never needs the user's path.
          const job = jobs.claim([source], targetId);
          if (!job) throw new PipelineError("JOB_LEASE_LOST");
          const documentId = jobs.recordArtifact(job, artifact);
          jobs.finish(job, { documentId });
        },
      });
      const result = db
        .prepare(
          `INSERT INTO local_pdf_imports (source_id, gemini_allowed)
      SELECT s.id, @gemini FROM document_sources s
      JOIN source_filings f ON f.id = s.filing_id
      JOIN documents d ON d.id = s.document_id
      WHERE f.source = @source AND f.source_filing_id = @filing AND d.sha256 = @digest
      ON CONFLICT(source_id) DO UPDATE SET gemini_allowed = max(gemini_allowed, excluded.gemini_allowed)
      RETURNING source_id, gemini_allowed`,
        )
        .all({
          source: filing.source,
          filing: filing.sourceFilingId,
          digest: artifact.sha256,
          gemini: Number(
            Boolean(input.summarize && config.AI_PROVIDER === "gemini"),
          ),
        });
      return {
        source: filing.source,
        sha256: artifact.sha256,
        imported: result.length > 0,
        gemini_authorized: result.some(
          ({ gemini_allowed }) => gemini_allowed === 1,
        ),
      };
    })
    .immediate();
}
