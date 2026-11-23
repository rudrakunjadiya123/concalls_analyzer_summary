import { stageDocument } from "../core/storage.js";
import { PipelineError } from "../core/errors.js";
import { withPdf } from "../pdf/document.js";

/** Validate the PDF container without reading its text in the download worker. */
export async function validatePdf(bytes, signal, maxPages) {
  await withPdf(bytes, { signal, maxPages }, (pdf) => pdf.getPage(1));
}

/**
 * Download and validate one approved attachment through its owning source adapter.
 * @param {Pick<import('../sources/types.js').FilingSource, 'download'>} source
 */
export async function downloadDocument(source, url, config, signal) {
  return source.download(url, { signal }, (stream, downloadSignal) => {
    const headers = stream.headers ?? {};
    const type = headers["content-type"]?.split(";")[0].trim().toLowerCase();
    // Some providers label PDFs as octet-stream, so inspect their bytes independently of the MIME hint.
    if (
      type &&
      ![
        "application/pdf",
        "application/octet-stream",
        "binary/octet-stream",
      ].includes(type)
    )
      throw new PipelineError("DOWNLOAD_INVALID_TYPE");
    if (
      headers["content-encoding"] &&
      headers["content-encoding"] !== "identity"
    )
      throw new PipelineError("DOWNLOAD_INVALID_TYPE");
    const length = headers["content-length"];
    const expectedBytes = length !== undefined ? Number(length) : undefined;
    if (
      length !== undefined &&
      (!/^\d+$/u.test(length) || !Number.isSafeInteger(expectedBytes))
    )
      throw new PipelineError("DOWNLOAD_INVALID_TYPE");
    return stageDocument(config.DATA_DIR, stream, {
      maxBytes: config.MAX_DOWNLOAD_BYTES,
      expectedBytes,
      signal: downloadSignal,
      validate: (bytes, abortSignal) =>
        validatePdf(bytes, abortSignal, config.MAX_PDF_PAGES),
    });
  });
}
