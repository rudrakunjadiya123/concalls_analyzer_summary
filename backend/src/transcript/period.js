import { dateSchema, quarterSchema } from "@finosauras/shared";

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const monthPattern = months
  .map(
    (name) =>
      `${name.slice(0, 3)}${name.length > 3 ? `(?:${name.slice(3)})?` : ""}`,
  )
  .join("|");
const iso = "(?<iso>\\d{4}-\\d{2}-\\d{2})";
const dayFirst = `(?<day>\\d{1,2})(?:st|nd|rd|th)?[ \\-]+(?<month>${monthPattern})\\.?[ ,\\-]+(?<year>20\\d{2})`;
const monthFirst = `(?<monthFirst>${monthPattern})\\.?[ ]+(?<dayFirst>\\d{1,2})(?:st|nd|rd|th)?[,]?[ ]+(?<yearFirst>20\\d{2})`;
const dates = `(?:${iso}|${dayFirst}|${monthFirst})`;
const ends = new RegExp(
  `\\b(?:quarter|period)\\s+(?:ended|ending|end)\\s*(?:on\\s+)?[:–-]?\\s*${dates}\\b`,
  "iu",
);
const calls = new RegExp(
  `\\b(?:call (?:date|held on|on)|date of (?:the )?call|conference (?:held on|on))\\s*[:–-]?\\s*${dates}\\b`,
  "iu",
);
const dateOnly = new RegExp(`^${dates}$`, "iu");
const titleDate = new RegExp(`^date\\s*:\\s*${dates}$`, "iu");
const quarters =
  /\bQ([1-4])\s*(?:[-–]\s*)?FY\s*['’]?(\d{4}|\d{2})(?:\s*[-–/]\s*(\d{4}|\d{2}))?\b/iu;
const callTitle =
  /\b(?:earnings|results?|investor|analyst|quarterly)\b.*\b(?:call|conference|transcript)\b|\b(?:call|conference)\b.*\b(?:earnings|results?|investor|analyst)\b/iu;
const titlePrefix =
  /\b(?:transcript of|corrected|revised|corrigendum|correction|updated)\b/giu;

export function identityText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isoDate(match) {
  if (!match) return null;
  const { iso, day, month, year, dayFirst, monthFirst, yearFirst } =
    match.groups;
  const mm =
    months.findIndex((name) =>
      name.startsWith((month ?? monthFirst ?? "").toLowerCase()),
    ) + 1;
  const date =
    iso ??
    `${year ?? yearFirst}-${String(mm).padStart(2, "0")}-${String(day ?? dayFirst).padStart(2, "0")}`;
  return dateSchema.safeParse(date).success ? date : null;
}

function explicitQuarter(text) {
  const hit = quarters.exec(text);
  if (!hit) return null;
  const [, quarter, first, last] = hit;
  if (last && ((Number(last) % 100) - (Number(first) % 100) + 100) % 100 !== 1)
    return null;
  return { value: `Q${quarter} FY${(last ?? first).slice(-2)}`, raw: hit[0] };
}

function quarterFromPeriod(date, start) {
  if (!date || !Number.isInteger(start) || start < 1 || start > 12) return null;
  const [year, month, day] = date.split("-").map(Number);
  const offset = (month - start + 12) % 12;
  // Require a quarter-ending month and the actual final day.
  if (
    offset % 3 !== 2 ||
    new Date(Date.UTC(year, month, 0)).getUTCDate() !== day
  )
    return null;
  const fy = start === 1 || month < start ? year : year + 1;
  return `Q${Math.floor(offset / 3) + 1} FY${String(fy).slice(-2)}`;
}

function earlyLines(extraction) {
  const firstSpeaker = extraction.blocks.find(({ speaker }) => speaker)
    ?.line_refs[0];
  return extraction.pages
    .slice(0, 3)
    .flatMap((page) =>
      page.lines.slice(0, 28).map((line, index) => ({
        ...line,
        page_number: page.page_number,
        line_number: index + 1,
      })),
    )
    .filter(
      (line) =>
        !firstSpeaker ||
        line.page_number < firstSpeaker.page_number ||
        (line.page_number === firstSpeaker.page_number &&
          line.line_number < firstSpeaker.line_number),
    );
}

/** Resolve explicitly supported metadata, retain all conflicting evidence, and avoid date inference from filing time. */
export function extractMetadata(extraction, filing, company, watchlist) {
  const provenance = [];
  const warnings = [];
  const first = earlyLines(extraction);
  let title = null;
  const add = (field, value, raw, confidence, line = null, source = "pdf") => {
    if (!value) return;
    provenance.push({
      field,
      value,
      source,
      source_filing_id: source === "pdf" ? null : filing.id,
      page_number: line?.page_number ?? null,
      line_number: line?.line_number ?? null,
      raw_expression: raw.slice(0, 500),
      confidence,
    });
  };
  if (dateSchema.safeParse(filing.call_date_hint).success)
    add(
      "call_date",
      filing.call_date_hint,
      filing.call_date_hint,
      "high",
      null,
      "filing_structured",
    );
  if (quarterSchema.safeParse(filing.quarter_hint).success)
    add(
      "quarter",
      filing.quarter_hint,
      filing.quarter_hint,
      "high",
      null,
      "filing_structured",
    );
  for (const [index, line] of first.entries()) {
    const text = line.text;
    if (!title && callTitle.test(text)) title = text;
    const period = ends.exec(text);
    add("period_end", isoDate(period), period?.[0] ?? "", "high", line);
    const date =
      calls.exec(text) ??
      (index > 0 && callTitle.test(first[index - 1].text)
        ? (dateOnly.exec(text) ?? titleDate.exec(text))
        : null);
    if (!period || date?.[0] !== period[0])
      add("call_date", isoDate(date), date?.[0] ?? "", "high", line);
    const q = explicitQuarter(text);
    if (q && (callTitle.test(text) || index < 12 || period))
      add("quarter", q.value, q.raw, "high", line);
    // Only title-band identities count. Mentions in analyst questions never establish the issuer.
    const lineIdentity = ` ${identityText(text)} `;
    const identityLabel =
      /^(?:issuer|company|nse(?: symbol)?|bse(?: scrip(?: code)?)?|isin)\s*:/iu.test(
        text,
      );
    for (const candidate of watchlist) {
      const full = identityText(candidate.display_name);
      const symbol = identityText(candidate.nse_symbol);
      const scrip = identityText(candidate.bse_scrip_code);
      const isin = identityText(candidate.isin);
      const matches =
        (full.length > 3 && lineIdentity.includes(` ${full} `)) ||
        (identityLabel &&
          [symbol, scrip, isin].some(
            (id) => id && lineIdentity.includes(` ${id} `),
          ));
      if (matches) add("company", candidate.id, text, "high", line);
    }
    if (
      /^\s*(?:company|issuer)\s*:/iu.test(text) &&
      !provenance.some(
        (item) =>
          item.field === "company" &&
          item.page_number === line.page_number &&
          item.line_number === line.line_number,
      )
    ) {
      const name = text.replace(/^\s*(?:company|issuer)\s*:\s*/iu, "");
      if (!(
        filing.source === "FIXTURE" &&
        filing.raw?.synthetic &&
        /^synthetic\b/iu.test(name)
      ))
        add(
          "company",
          `unverified:${identityText(name)}`,
          text,
          "medium",
          line,
        );
    }
  }
  if (
    filing.source === "FIXTURE"
      ? filing.raw?.synthetic === true
      : Boolean(company.identity_verified_at)
  )
    add(
      "company",
      company.id,
      filing.source === "FIXTURE"
        ? "synthetic routing identity"
        : "verified filing identity",
      "high",
      null,
      "filing_structured",
    );
  const subject = filing.subject ?? "";
  const details = filing.description ?? "";
  for (const text of [subject, details]) {
    if (!callTitle.test(`${subject} ${text}`) && !/transcript/iu.test(subject))
      continue;
    const q = explicitQuarter(text);
    if (q) add("quarter", q.value, q.raw, "medium", null, "filing_description");
    const period = ends.exec(text);
    add(
      "period_end",
      isoDate(period),
      period?.[0] ?? "",
      "medium",
      null,
      "filing_description",
    );
    const date = calls.exec(text);
    add(
      "call_date",
      isoDate(date),
      date?.[0] ?? "",
      "medium",
      null,
      "filing_description",
    );
  }
  const resolve = (field) => {
    const values = [
      ...new Set(
        provenance
          .filter((item) => item.field === field)
          .map(({ value }) => value),
      ),
    ];
    if (values.length > 1) warnings.push(`${field}_conflict`);
    return values.length === 1 ? values[0] : null;
  };
  const period = resolve("period_end");
  const derived = quarterFromPeriod(period, company.fiscal_year_start_month);
  if (derived) {
    const evidence = provenance.find(
      (item) => item.field === "period_end" && item.value === period,
    );
    add(
      "quarter",
      derived,
      evidence.raw_expression,
      evidence.confidence,
      evidence.page_number ? evidence : null,
      evidence.source,
    );
  }
  const call = resolve("call_date");
  const quarter = resolve("quarter");
  const companyId = resolve("company");
  if (!call) warnings.push("call_date_unconfirmed");
  if (!quarter) warnings.push("quarter_unconfirmed");
  if (companyId !== company.id) warnings.push("company_identity_unconfirmed");
  const normalizedTitle = identityText(
    (title ?? (callTitle.test(subject) ? subject : "")).replace(
      titlePrefix,
      " ",
    ),
  );
  return {
    call_date: call,
    quarter,
    period_end: period,
    company_confirmed: companyId === company.id,
    normalized_title: normalizedTitle,
    warnings,
    metadata_provenance: provenance,
  };
}
