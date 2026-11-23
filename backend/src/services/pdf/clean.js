import { speakerLabel } from "./speakers.js";

const ligatures = {
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st",
};
const pageNumber = /^(?:page\s+)?(\d{1,3})(?:\s*(?:\/|of)\s*\d{1,3})?$/iu;
const value =
  /[₹%$€]|\b(?:crore|lakh|bps|revenue|margin|cash flow|rupees|ebitda)\b/iu;

function margin(page, line) {
  if (line.y <= page.height * 0.09) return "top";
  if (line.y >= page.height * 0.91) return "bottom";
  return null;
}

function repeatKey(page, line) {
  const band = margin(page, line);
  if (
    !band ||
    line.kind === "table" ||
    value.test(line.text) ||
    speakerLabel(line.text)
  )
    return null;
  // Keep call titles, period labels and dates available for metadata provenance.
  if (
    /\b(?:earnings|conference call|transcript|quarter|FY\d|financial year)\b/iu.test(
      line.text,
    )
  )
    return null;
  return `${band}:${line.text.toLowerCase().replace(/\d+/gu, "#").trim()}`;
}

/** Remove recurrent marginal furniture while preserving all original lines and numeric content. */
export function cleanPages(pages) {
  const counts = new Map();
  for (const page of pages) {
    for (const key of new Set(
      page.ordered_lines.map((line) => repeatKey(page, line)).filter(Boolean),
    )) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const minimum = Math.max(2, Math.ceil(pages.length * 0.6));
  return pages.map((page) => {
    let removed = 0;
    const lines = page.ordered_lines.flatMap((line, index) => {
      const number = pageNumber.exec(line.text.trim());
      const isPage =
        number &&
        margin(page, line) &&
        (Number(number[1]) === page.page_number ||
          /^page\s|\/|\sof\s/iu.test(line.text));
      const key = repeatKey(page, line);
      if (isPage || (key && counts.get(key) >= minimum)) {
        removed++;
        return [];
      }
      const text = line.text
        .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/gu, (glyph) => ligatures[glyph])
        .replace(/[^\S\n]+/gu, line.kind === "table" ? "$&" : " ")
        .trim();
      return text ? [{ ...line, text, ordered_line: index + 1 }] : [];
    });
    return {
      ...page,
      lines,
      cleaned_text: lines.map(({ text }) => text).join("\n"),
      quality: { ...page.quality, removed_margin_lines: removed },
    };
  });
}

/** Deduplication intentionally folds whitespace only, never spelling or financial symbols. */
export function normalizeCompleteText(pages) {
  return pages
    .map(({ cleaned_text }) => cleaned_text)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
}
