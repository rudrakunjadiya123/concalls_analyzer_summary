import { PipelineError } from "../core/errors.js";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
export const normalizedQuote = (value) => value.replace(/\s+/gu, " ").trim();
const executiveTitle =
  "(?:chief (?:executive|financial|operating|technology) officer|managing director|CEO|CFO|COO|CTO)\\b";
const questionLead =
  /^(?:could|can|would|what|why|how|when|where|is|are|do|does|did)\b/iu;

/** Estimate complete serialized input conservatively enough for mixed scripts and symbols. */
export function estimateTokens(value) {
  return Math.ceil(
    Buffer.byteLength(
      typeof value === "string" ? value : JSON.stringify(value),
    ) / 3,
  );
}

function withoutLabel(text, speaker) {
  if (!speaker) return text;
  const label = text.indexOf(":");
  // PDF extraction may have retained a standalone label or an inline role suffix.
  const startsWithSpeaker =
    text.startsWith(speaker) &&
    /^\s*(?::|[–—-]|\(|$)/u.test(text.slice(speaker.length));
  if (text === speaker || (startsWithSpeaker && label < 0)) return "";
  return startsWithSpeaker && label >= 0 ? text.slice(label + 1).trim() : text;
}

/** Turn the Stage 3 page references into citable page-local sentence and table units. */
export function evidenceUnits(manifest) {
  const units = [];
  const introduction = normalizedQuote(
    manifest.pages
      .slice(0, 4)
      .map((page) => page.cleaned_text)
      .join(" "),
  );
  const namedSpeakers = new Set(
    manifest.blocks.map((block) => block.speaker).filter(Boolean),
  );
  const executives = new Set(
    [...namedSpeakers].filter((name) => {
      if (!name.includes(" ") || name.length > 84) return false;
      const literal = normalizedQuote(name).replace(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      );
      // Only assign a role when the PDF places an executive title directly after the name.
      return new RegExp(
        `(?:^|[^\\p{L}])${literal}\\s*(?:[-–—:]+|\\()?\\s*${executiveTitle}`,
        "iu",
      ).test(introduction);
    }),
  );
  for (const block of manifest.blocks) {
    const groups = new Map();
    for (const { page_number: page, line_number: line } of block.line_refs) {
      const text = manifest.pages[page - 1].lines[line - 1].text;
      const content =
        groups.size === 0 ? withoutLabel(text, block.speaker) : text;
      if (!content.trim()) continue;
      if (!groups.has(page)) groups.set(page, []);
      groups.get(page).push(content);
    }
    let part = 0;
    for (const [page, lines] of groups) {
      const text = normalizedQuote(lines.join(" "));
      const pieces =
        block.kind === "table"
          ? [text]
          : [...sentences.segment(text)].map(({ segment }) => segment.trim());
      for (const piece of pieces) {
        if (!piece) continue;
        units.push({
          id: `${block.block_id}:${++part}`,
          block: block.block_id,
          page,
          speaker: block.speaker,
          kind:
            block.kind === "unattributed" &&
            executives.has(block.speaker) &&
            !piece.endsWith("?") &&
            !questionLead.test(piece)
              ? "management"
              : block.kind,
          text: piece,
        });
      }
    }
  }
  return units;
}

// A range plus its currency and units is one atom, even when the print uses spaces.
const atom =
  /(?:₹|INR\s+|Rs\.?\s+|[$€£])?\s*[+−–-]?\d[\d,.]*(?:\s*(?:[-–−]|to)\s*[+−]?\d[\d,.]*)?(?:\s*(?:%|crores?\b|lakhs?\b|bps\b|million\b|billion\b|times\b))?|\S+/giu;

function split(unit, limit) {
  if (estimateTokens(unit) <= limit) return [unit];
  const atoms = unit.text.match(atom) ?? [];
  const fragments = [];
  let text = "";
  for (const value of atoms) {
    const candidate = [text, value.trim()].filter(Boolean).join(" ");
    if (estimateTokens({ ...unit, text: candidate, partial: true }) > limit) {
      if (!text) throw new PipelineError("AI_CONTEXT_LIMIT");
      fragments.push({
        ...unit,
        id: `${unit.id}.${fragments.length + 1}`,
        text,
        partial: true,
      });
      text = value.trim();
      if (estimateTokens({ ...unit, text, partial: true }) > limit)
        throw new PipelineError("AI_CONTEXT_LIMIT");
    } else text = candidate;
  }
  if (text)
    fragments.push({
      ...unit,
      id: `${unit.id}.${fragments.length + 1}`,
      text,
      partial: true,
    });
  // An oversized sentence can provide context but cannot become an independently published quotation.
  return fragments;
}

/** Build bounded map requests covering every page, with a trailing overlap of whole units. */
export function chunkDocument(
  manifest,
  { target, overlap, maxTotal, excludedPages = [] },
) {
  const excluded = new Set(excludedPages);
  const units = evidenceUnits(manifest).filter(
    ({ page }) => !excluded.has(page),
  );
  if (estimateTokens(units) > maxTotal)
    throw new PipelineError("AI_BUDGET_EXCEEDED");
  const room = target - 24;
  if (room < 48) throw new PipelineError("AI_CONTEXT_LIMIT");
  const pieces = units.flatMap((unit) => split(unit, room - 2));
  const batches = [];
  let current = [];
  let size = 0;
  for (const unit of pieces) {
    const cost = estimateTokens(unit) + 1;
    if (size + cost > room && current.length) {
      batches.push({ number: batches.length + 1, units: current });
      let carrySize = 0;
      const carry = [];
      for (let index = current.length - 1; index >= 0; index--) {
        const previous = estimateTokens(current[index]) + 1;
        if (carrySize + previous > Math.min(overlap, room - cost)) break;
        carry.unshift(current[index]);
        carrySize += previous;
      }
      current = carry;
      size = carrySize;
    }
    current.push(unit);
    size += cost;
  }
  if (current.length)
    batches.push({ number: batches.length + 1, units: current });
  return { units, batches };
}
