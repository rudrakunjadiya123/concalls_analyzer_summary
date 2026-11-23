import { z } from "zod";
import { utcInstantSchema } from "@finosauras/shared";
import { parseNormalizedFiling } from "../domain/filing.js";
import { parseSourceUrl } from "../core/security.js";
import { istDate, istLocalToUtc, utcIso } from "../core/clock.js";
import { PipelineError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";

export const optionalText = z.string().nullish();
export const optionalId = z
  .union([z.string(), z.int().nonnegative()])
  .nullish();
export const clean = (value) => value?.trim() || null;
export const read = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PipelineError("SOURCE_SCHEMA_CHANGED");
  return parsed.data;
};

const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** Parse observed exchange-local and explicit-offset timestamp shapes. */
export function publicationTime(input) {
  if (!clean(input)) return null;
  let value = input.trim().replace(/^(\d{4}-\d\d-\d\d)\s+/u, "$1T");
  value = value
    .replace(
      /^(\d\d)[-/]([a-z]{3}|\d\d)[-/](\d{4})\s+/iu,
      (_, day, rawMonth, year) => {
        const month = /^\d/u.test(rawMonth)
          ? rawMonth
          : String(months.indexOf(rawMonth.toLowerCase()) + 1).padStart(2, "0");
        return `${year}-${month}-${day}T`;
      },
    )
    .replace(/(\.\d{3})\d+(?=$|Z|[+-]\d\d:?\d\d$)/u, "$1")
    .replace(/([+-]\d\d)(\d\d)$/u, "$1:$2");
  try {
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/u.test(value)) {
      utcInstantSchema.parse(value.replace(/[+-]\d\d:\d\d$/u, "Z"));
      return utcIso(new Date(value));
    }
    return istLocalToUtc(value);
  } catch {
    throw new PipelineError("SOURCE_SCHEMA_CHANGED");
  }
}

/** Produce the exchange's date query format from the actual IST calendar date. */
export function queryDate(instant, format) {
  const [year, month, day] = istDate(instant).split("-");
  return format === "nse" ? `${day}-${month}-${year}` : `${year}${month}${day}`;
}

export function safePublicLink(value) {
  if (!value) return null;
  try {
    return parseSourceUrl(value).href;
  } catch {
    return null;
  }
}

/** Classify attachment metadata by name, without trusting it as a content check. */
export function attachment(link, name, hint) {
  const url = safePublicLink(link);
  if (!url) return null;
  let filename;
  try {
    filename =
      name ?? decodeURIComponent(new URL(url).pathname.split("/").at(-1));
  } catch {
    return null;
  }
  if (
    !filename ||
    /[/\\:\p{Cc}]/u.test(filename) ||
    [".", ".."].includes(filename)
  )
    return null;
  const kindHint = /\.(xml|xbrl)$/iu.test(filename)
    ? "xbrl"
    : /\.(mp3|wav|m4a|mp4|aac|webm|ogg)$/iu.test(filename) || hint === "audio"
      ? "audio"
      : /\.pdf$/iu.test(filename) || hint === "pdf"
        ? "pdf"
        : "other";
  return {
    url,
    filename,
    kindHint,
    contentTypeHint: kindHint === "pdf" ? "application/pdf" : null,
  };
}

/** Preserve a real filing ID where available, otherwise fingerprint stable source fields. */
export function normalized(source, fields, expected, logger) {
  const id =
    fields.sourceFilingId === null || fields.sourceFilingId === undefined
      ? ""
      : String(fields.sourceFilingId).trim();
  const { company, publishedAt, subject, attachments } = fields;
  if (!id)
    logger?.warn("source_filing_id_fingerprint", { stage: "source", source });
  const sourceFilingId =
    id ||
    `fingerprint:${sha256(
      JSON.stringify([
        source,
        company.isin ?? company.nseSymbol ?? company.bseScripCode,
        publishedAt,
        subject,
        attachments.map(({ filename }) => filename).sort(),
      ]),
    )}`;
  return parseNormalizedFiling(
    {
      ...fields,
      source,
      sourceFilingId,
      callDateHint: null,
      quarterHint: null,
    },
    expected,
  );
}

export function incomplete(fetchedPages, reason) {
  return {
    complete: false,
    records: [],
    fetchedPages,
    diagnostics: { reason },
  };
}
