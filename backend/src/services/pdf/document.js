import path from "node:path";
import { createRequire } from "node:module";
import { PipelineError } from "../../utils/errors.js";

const packageDir = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
// PDF.js checks for a URL-style trailing slash even with its local Node data factory.
const bundled = (name) =>
  `${path.join(packageDir, name).replaceAll("\\", "/")}/`;

/** Open local PDF bytes under the same preflight constraints for both ingestion and extraction. */
export async function withPdf(bytes, { maxPages, signal }, use) {
  const tail = bytes
    .subarray(Math.max(0, bytes.length - 1024))
    .toString("latin1");
  if (
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
    !/%%EOF[\s\0]*$/u.test(tail)
  )
    throw new PipelineError("PDF_CORRUPT");
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal?.throwIfAborted();
  const task = library.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    cMapUrl: bundled("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: bundled("standard_fonts"),
    maxImageSize: 16_000_000,
    verbosity: library.VerbosityLevel.ERRORS,
  });
  let destroying;
  const destroy = () => {
    destroying ??= task.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
      throw new PipelineError("PDF_CORRUPT");
    if (document.numPages > maxPages)
      throw new PipelineError("PDF_TOO_MANY_PAGES");
    const result = await use(document, library);
    signal?.throwIfAborted();
    return result;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError(
      cause.name === "PasswordException"
        ? "PDF_PASSWORD_PROTECTED"
        : "PDF_CORRUPT",
      undefined,
      { cause },
    );
  } finally {
    signal?.removeEventListener("abort", destroy);
    destroy();
    await destroying;
  }
}
