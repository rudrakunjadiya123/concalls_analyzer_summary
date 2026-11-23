import { lstat, open } from "node:fs/promises";
import { PipelineError } from "../../utils/errors.js";
import { sha256 } from "../../utils/hash.js";
import { parseSourceUrl } from "../../utils/security.js";
import { parseNormalizedFiling } from "../../models/filing.js";

const localReference = (digest) => `https://local-pdf.invalid/${digest}.pdf`;

/** Bind a local file to a known exchange link or an explicitly identified archive filing. */
export function createLocalPdfSource(filePath, sourceUrl, archiveExchange) {
  if (
    !filePath ||
    Boolean(sourceUrl) === Boolean(archiveExchange) ||
    (archiveExchange && !["NSE", "BSE"].includes(archiveExchange))
  )
    throw new PipelineError("BAD_REQUEST");
  const url = parseSourceUrl(sourceUrl || localReference(sha256(filePath)));
  const source =
    archiveExchange ??
    (/(?:^|\.)nseindia\.(?:com|in)$/u.test(url.hostname)
      ? "NSE"
      : /(?:^|\.)bseindia\.com$/u.test(url.hostname)
        ? "BSE"
        : null);
  if (!source || url.search || !/\.pdf$/iu.test(url.pathname))
    throw new PipelineError("DOWNLOAD_UNSAFE_URL");
  const allowedAttachment = (candidate) =>
    candidate === url.href ||
    Boolean(
      archiveExchange &&
      /^https:\/\/local-pdf\.invalid\/[a-f\d]{64}\.pdf$/u.test(candidate),
    );
  return {
    source,
    cacheNamespace: "local_pdf",
    allowedAttachment,
    filing(company, { title, publishedAt }, digest) {
      // The archive reference is internal and never exposed as an exchange download URL.
      const reference =
        archiveExchange && digest ? localReference(digest) : url.href;
      return parseNormalizedFiling({
        source,
        sourceFilingId: `local:${sha256(reference)}`,
        sourceUrl: reference,
        company,
        subject: title ?? "Earnings conference call transcript",
        description: "",
        category: null,
        subcategory: null,
        publishedAt: publishedAt ?? null,
        callDateHint: null,
        quarterHint: null,
        attachments: [
          {
            url: reference,
            filename: "transcript.pdf",
            contentTypeHint: "application/pdf",
            kindHint: "pdf",
          },
        ],
        raw: {
          acquisition: "local_pdf",
          pdfSha256: digest,
          ...(archiveExchange ? { originalExchangeUrlUnverified: true } : {}),
        },
      });
    },
    async download(candidate, { signal }, consume) {
      if (!allowedAttachment(candidate))
        throw new PipelineError("DOWNLOAD_UNSAFE_URL");
      signal?.throwIfAborted();
      // The URL is a reference only. The adapter reads the local file without making a request.
      const { file, size } = await openRegularFile(filePath);
      // Let the consumer handle cancellation while streaming. This adapter owns cleanup.
      const stream = file.createReadStream({ autoClose: false });
      try {
        stream.headers = { "content-length": String(size) };
        return await consume(stream, signal);
      } finally {
        stream.destroy();
        await file.close();
      }
    },
    url: url.href,
  };
}

async function openRegularFile(filePath) {
  let file;
  try {
    const original = await lstat(filePath, { bigint: true });
    if (!original.isFile()) throw new PipelineError("UNSAFE_PATH");
    file = await open(filePath, "r");
    const current = await file.stat({ bigint: true });
    // Windows path stats can omit the volume identifier even when handle stats provide it.
    if (
      !current.isFile() ||
      (original.dev !== 0n && current.dev !== original.dev) ||
      current.ino !== original.ino
    )
      throw new PipelineError("UNSAFE_PATH");
    return { file, size: current.size };
  } catch (cause) {
    await file?.close();
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError("FILE_IO_ERROR", undefined, { cause });
  }
}
