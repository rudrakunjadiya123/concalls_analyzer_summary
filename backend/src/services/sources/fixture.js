import { createReadStream } from "node:fs";
import { parseNormalizedFiling } from "../../models/filing.js";
import { PipelineError } from "../../utils/errors.js";

export const FIXTURE_FROM = "2026-10-25T00:00:00.000Z";
export const FIXTURE_TO = "2026-10-28T00:00:00.000Z";
const publishedAt = "2026-10-26T10:00:00.000Z";
const origin = "https://fixture.finosauras.invalid";
// Resolve backend-owned fixture PDFs independently of the process working directory.
const pdfDirectory = new URL("../../../fixtures/pdf/", import.meta.url);
const documents = new Map(
  ["transcript", "cover-letter"].map((key) => [
    `${origin}/${key}.pdf`,
    new URL(
      key === "transcript"
        ? "stage4/synthetic-call.pdf"
        : "synthetic-cover-letter.pdf",
      pdfDirectory,
    ),
  ]),
);
const replayFiles = {
  replay: new URL("stage5/replay-call.pdf", pdfDirectory),
  correction: new URL("stage5/replay-correction.pdf", pdfDirectory),
};
for (const [key, file] of Object.entries(replayFiles))
  documents.set(`${origin}/${key}.pdf`, file);

/** Fixture PDFs are resolved by exact internal keys; no URL goes to a network client. */
export const isFixtureAttachment = (url) => documents.has(url);
export function openFixtureAttachment(url, signal) {
  const filename = documents.get(url);
  if (!filename) throw new PipelineError("DOWNLOAD_UNSAFE_URL");
  return createReadStream(filename, { signal });
}

/** Replay deterministic synthetic announcements against a single routing partition. */
export async function discoverFixture({ from, to, company, signal }) {
  signal?.throwIfAborted();
  const instant = Date.parse(publishedAt);
  const rows =
    company.nseSymbol === "INFY" &&
    from.getTime() <= instant &&
    instant < to.getTime()
      ? [...documents.keys()].slice(0, 2).map((url, index) =>
          parseNormalizedFiling(
            {
              source: "FIXTURE",
              sourceFilingId: index
                ? "synthetic-stage2-2"
                : "synthetic-stage4-call",
              // INFY is only a local routing anchor. The fictional text names no listed company.
              company: {
                displayName: "Synthetic Test Company",
                nseSymbol: company.nseSymbol,
                bseScripCode: null,
                isin: null,
              },
              subject: index
                ? "Covering letter for earnings call transcript"
                : "Updates",
              description: index
                ? "Synthetic notice referring to an earnings call transcript."
                : "Synthetic earnings call transcript fixture.",
              category: "Synthetic demo",
              subcategory: null,
              publishedAt,
              callDateHint: null,
              quarterHint: null,
              sourceUrl: `${origin}/announcements/${index + 1}`,
              attachments: [
                {
                  url,
                  filename: new URL(url).pathname.slice(1),
                  contentTypeHint: "application/pdf",
                  kindHint: "pdf",
                },
              ],
              raw: {
                synthetic: true,
                fixture: index ? "stage2" : "stage4",
                documentKind: index ? "cover_letter" : "dialogue",
              },
            },
            company,
          ),
        )
      : [];
  return {
    records: rows,
    complete: true,
    fetchedPages: 1,
    diagnostics: { synthetic: true },
  };
}

/** Construct a distinct fictional call or a later correction to that same call. */
export function replayFiling(variant, company) {
  const adjusted = variant === "correction";
  const url = `${origin}/${variant}.pdf`;
  if (!replayFiles[variant]) throw new PipelineError("BAD_REQUEST");
  return parseNormalizedFiling(
    {
      source: "FIXTURE",
      sourceFilingId: "synthetic-stage5-replay",
      company: {
        displayName: "Synthetic Test Company",
        nseSymbol: company.nseSymbol,
        bseScripCode: null,
        isin: null,
      },
      subject: adjusted
        ? "Corrected synthetic Industrial earnings conference call transcript"
        : "Synthetic Industrial earnings conference call transcript",
      description: "Fictional replay transcript with no real company results.",
      category: "Synthetic demo",
      subcategory: null,
      publishedAt: adjusted
        ? "2026-11-18T12:00:00.000Z"
        : "2026-11-18T10:00:00.000Z",
      callDateHint: null,
      quarterHint: null,
      sourceUrl: `${origin}/announcements/${variant}`,
      attachments: [
        {
          url,
          filename: `${variant}.pdf`,
          contentTypeHint: "application/pdf",
          kindHint: "pdf",
        },
      ],
      raw: { synthetic: true, fixture: "stage5", variant },
    },
    {
      displayName: company.displayName,
      nseSymbol: company.nseSymbol,
      bseScripCode: company.bseScripCode,
      isin: company.isin,
    },
  );
}
