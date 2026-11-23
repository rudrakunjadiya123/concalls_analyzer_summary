import { z } from "zod";
import { pageExtractSchema, transcriptBlockSchema } from "@finosauras/shared";
import { atomicWrite, readPrivateFile } from "../core/storage.js";
import { documentStorageKey, sha256 } from "../core/hash.js";
import { PipelineError } from "../core/errors.js";
import { normalizeCompleteText } from "./clean.js";
import { extractPdf, EXTRACTION_VERSION } from "./extract.js";

const digest = z.string().regex(/^[a-f\d]{64}$/u);
const confidence = z.enum(["high", "low"]);
const maxArtifactBytes = 64 * 1024 * 1024;
const rawItem = z.strictObject({
  str: z.string(),
  transform: z.array(z.number()).length(6),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  dir: z.string(),
  font_name: z.string(),
  has_eol: z.boolean(),
  rotated: z.boolean(),
});
const lineSchema = z.strictObject({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  kind: z.enum(["line", "table"]),
});
const pageSchema = pageExtractSchema.extend({
  width: z.number().positive(),
  height: z.number().positive(),
  raw_items: z.array(rawItem),
  ordered_lines: z.array(lineSchema),
  quality: z.strictObject({
    reading_order_confidence: confidence,
    columns: z.union([z.literal(1), z.literal(2)]),
    image_only_suspected: z.boolean(),
    removed_margin_lines: z.int().nonnegative(),
  }),
});
export const extractionQualitySchema = z.strictObject({
  text_pages: z.int().nonnegative(),
  empty_pages: z.int().nonnegative(),
  image_only_pages: z.int().nonnegative(),
  suspected_scanned: z.boolean(),
  chars_per_page: z.array(z.int().nonnegative()),
  replacement_characters: z.int().nonnegative(),
  suspicious_spacing_lines: z.int().nonnegative(),
  speaker_turns: z.int().nonnegative(),
  has_speaker_turns: z.boolean(),
  reading_order_confidence: confidence,
  warnings: z.array(z.string()),
});
const artifactSchema = z
  .strictObject({
    document_id: z.uuid(),
    document_sha256: digest,
    extraction_version: z.literal(EXTRACTION_VERSION),
    page_count: z.int().positive(),
    quality: extractionQualitySchema,
    pages: z.array(pageSchema),
    blocks: z.array(transcriptBlockSchema),
    raw_sha256: digest,
    clean_sha256: digest,
    clean_text_sha256: digest,
  })
  .refine(
    (data) =>
      data.pages.length === data.page_count &&
      data.pages.every((page, index) => page.page_number === index + 1) &&
      data.blocks.every(
        (block) =>
          block.line_refs?.length &&
          block.line_refs[0].page_number === block.page_start &&
          block.line_refs.at(-1).page_number === block.page_end &&
          block.line_refs.every(
            (ref) =>
              ref.page_number >= block.page_start &&
              ref.page_number <= block.page_end &&
              ref.line_number <=
                (data.pages[ref.page_number - 1]?.lines.length ?? 0),
          ),
      ),
    "Invalid artifact provenance",
  );

function artifactPaths(hash) {
  digest.parse(hash);
  return {
    raw: `extracted/${hash}.raw.txt`,
    clean: `extracted/${hash}.clean.txt`,
    pages: `extracted/${hash}.pages.json`,
  };
}

/** Load the final manifest only if all components still match its source hash, version and text digests. */
export async function loadExtraction(document, config, signal) {
  const paths = artifactPaths(document.sha256);
  try {
    const bytes = await readPrivateFile(config.DATA_DIR, paths.pages, {
      maxBytes: maxArtifactBytes,
      signal,
    });
    const manifest = artifactSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      manifest.document_id !== document.id ||
      manifest.document_sha256 !== document.sha256
    )
      return null;
    const raw = await readPrivateFile(config.DATA_DIR, paths.raw, {
      maxBytes: maxArtifactBytes,
      signal,
    });
    const clean = await readPrivateFile(config.DATA_DIR, paths.clean, {
      maxBytes: maxArtifactBytes,
      signal,
    });
    if (
      sha256(raw) !== manifest.raw_sha256 ||
      sha256(clean) !== manifest.clean_sha256 ||
      sha256(normalizeCompleteText(manifest.pages)) !==
        manifest.clean_text_sha256
    )
      return null;
    return {
      manifest,
      paths,
      characterCount: manifest.quality.chars_per_page.reduce(
        (a, b) => a + b,
        0,
      ),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error.code === "ENOENT" ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}

/** Reuse a complete private extraction checkpoint, or generate one from the canonical stored bytes. */
export async function materializeExtraction(document, config, signal) {
  const cached = await loadExtraction(document, config, signal);
  if (cached) return cached;
  const key = documentStorageKey(document.sha256);
  if (key !== document.storage_relative_path)
    throw new PipelineError("UNSAFE_PATH");
  let bytes;
  try {
    bytes = await readPrivateFile(config.DATA_DIR, key, {
      maxBytes: config.MAX_DOWNLOAD_BYTES,
      signal,
    });
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError("FILE_IO_ERROR", undefined, {
      cause,
      retryable: true,
    });
  }
  if (sha256(bytes) !== document.sha256) throw new PipelineError("PDF_CORRUPT");
  const extraction = await extractPdf(bytes, {
    maxBytes: config.MAX_DOWNLOAD_BYTES,
    maxPages: config.MAX_PDF_PAGES,
    signal,
  });
  const text = (field) =>
    extraction.pages
      .map((page) => `[Page ${page.page_number}]\n${page[field]}`)
      .join("\n\n");
  const raw = text("raw_text");
  const clean = text("cleaned_text");
  const manifest = artifactSchema.parse({
    ...extraction,
    document_id: document.id,
    document_sha256: document.sha256,
    raw_sha256: sha256(raw),
    clean_sha256: sha256(clean),
    clean_text_sha256: sha256(normalizeCompleteText(extraction.pages)),
  });
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > maxArtifactBytes)
    throw new PipelineError("PDF_RESOURCE_LIMIT");
  const paths = artifactPaths(document.sha256);
  // Publish the checksummed manifest last so a partial crash cannot pass validation.
  await atomicWrite(config.DATA_DIR, paths.raw, raw);
  await atomicWrite(config.DATA_DIR, paths.clean, clean);
  await atomicWrite(config.DATA_DIR, paths.pages, serialized);
  return {
    manifest,
    paths,
    characterCount: extraction.quality.chars_per_page.reduce(
      (a, b) => a + b,
      0,
    ),
  };
}
