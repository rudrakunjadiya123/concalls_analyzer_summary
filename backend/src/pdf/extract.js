import { lstat, readFile } from "node:fs/promises";
import { PipelineError } from "../core/errors.js";
import { withPdf } from "./document.js";
import { orderPage } from "./readingOrder.js";
import { cleanPages } from "./clean.js";
import { buildBlocks } from "./speakers.js";

export const EXTRACTION_VERSION = "pdfjs-v1";
const maxCharacters = 2_000_000;
const maxItems = 100_000;

/** Extract a bounded PDF buffer or a trusted local file path into page-aware text. */
export async function extractPdf(
  input,
  { maxBytes = 25_000_000, maxPages = 150, signal } = {},
) {
  const deadline = AbortSignal.timeout(60_000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let bytes = input;
  try {
    if (typeof input === "string") {
      const stat = await lstat(input);
      if (!stat.isFile() || stat.nlink > 1)
        throw new PipelineError("UNSAFE_PATH");
      if (stat.size > maxBytes) throw new PipelineError("PDF_RESOURCE_LIMIT");
      bytes = await readFile(input, { signal: active });
    }
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("Expected PDF bytes or a local path");
    if (bytes.length > maxBytes) throw new PipelineError("PDF_RESOURCE_LIMIT");
    return await withPdf(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { maxPages, signal: active },
      async (pdf, { Util, OPS }) =>
        extractPages(pdf, { Util, OPS, signal: active }),
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      throw new PipelineError("PDF_EXTRACTION_TIMEOUT", undefined, {
        retryable: true,
      });
    throw error;
  }
}

async function extractPages(pdf, { Util, OPS, signal }) {
  const pages = [];
  let characters = 0;
  let itemCount = 0;
  for (let number = 1; number <= pdf.numPages; number++) {
    signal.throwIfAborted();
    const page = await pdf.getPage(number);
    try {
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: true });
      const items = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        characters += item.str.length;
        if (++itemCount > maxItems || characters > maxCharacters)
          throw new PipelineError("PDF_RESOURCE_LIMIT");
        const transform = Util.transform(view.transform, item.transform);
        items.push({
          str: item.str,
          transform: item.transform,
          x: transform[4],
          y: transform[5],
          width: item.width,
          height: item.height || Math.hypot(transform[2], transform[3]),
          dir: item.dir,
          font_name: item.fontName,
          has_eol: item.hasEOL,
          rotated: Math.abs(transform[1]) > Math.abs(transform[0]) * 0.25,
        });
      }
      const raw = items
        .map(({ str, has_eol }) => str + (has_eol ? "\n" : ""))
        .join("");
      const ordered = orderPage(items, view.width, view.height);
      let imageOnly = false;
      if (!raw.trim()) {
        // Inspect image operators only when text is absent, without rendering the page.
        const operations = await page.getOperatorList();
        imageOnly = operations.fnArray.some((op) =>
          [
            OPS.paintImageXObject,
            OPS.paintInlineImageXObject,
            OPS.paintImageXObjectRepeat,
            OPS.paintInlineImageXObjectGroup,
          ].includes(op),
        );
      }
      pages.push({
        page_number: number,
        width: view.width,
        height: view.height,
        raw_items: items,
        raw_text: raw,
        ordered_lines: ordered.lines,
        quality: {
          reading_order_confidence: ordered.confidence,
          columns: ordered.columns,
          image_only_suspected: imageOnly,
        },
      });
    } finally {
      page.cleanup();
    }
  }
  const cleaned = cleanPages(pages);
  const { blocks, turns } = buildBlocks(cleaned);
  const chars = cleaned.map(({ cleaned_text }) => cleaned_text.length);
  const textPages = chars.filter(Boolean).length;
  const imagePages = cleaned.filter(
    ({ quality }) => quality.image_only_suspected,
  ).length;
  const replacements = cleaned.reduce(
    (count, page) => count + (page.raw_text.match(/\uFFFD/gu)?.length ?? 0),
    0,
  );
  const oddSpacing = cleaned.reduce(
    (count, page) =>
      count +
      page.lines.filter(({ text }) => /(?:\b\p{L}\s+){5,}/u.test(text)).length,
    0,
  );
  const lowOrder = cleaned.some(
    ({ quality }) => quality.reading_order_confidence === "low",
  );
  const suspected = imagePages > 0 && textPages <= cleaned.length / 2;
  const warnings = [
    ...(suspected
      ? ["image_only_suspected", "ocr_needed"]
      : imagePages
        ? ["mixed_image_pages"]
        : []),
    ...(chars.reduce((sum, count) => sum + count, 0) < 100 ? ["low_text"] : []),
    ...(lowOrder ? ["layout_low_confidence"] : []),
    ...(replacements ? ["replacement_characters"] : []),
    ...(oddSpacing ? ["suspicious_spacing"] : []),
    ...(chars.some((count) => count > 15_000)
      ? ["high_character_density"]
      : []),
  ];
  return {
    extraction_version: EXTRACTION_VERSION,
    page_count: cleaned.length,
    pages: cleaned,
    blocks,
    quality: {
      text_pages: textPages,
      empty_pages: cleaned.length - textPages,
      image_only_pages: imagePages,
      suspected_scanned: suspected,
      chars_per_page: chars,
      replacement_characters: replacements,
      suspicious_spacing_lines: oddSpacing,
      speaker_turns: turns,
      has_speaker_turns: turns > 0,
      reading_order_confidence: lowOrder ? "low" : "high",
      warnings,
    },
  };
}
