import { sha256 } from "../core/hash.js";
import { normalizedQuote } from "./chunk.js";

const future =
  /\b(?:expect(?:s|ed)?|target(?:s|ing)?|forecast(?:s)?|guidance|project(?:s|ed)?|outlook|plans? to|anticipat(?:e|es)|aim(?:s)? to|will|could reach)\b/iu;
const withheld =
  /\b(?:no guidance|(?:not|never)\s+(?:giv|provid|issu)\w+\s+(?:any\s+)?guidance|declin\w+\s+to\s+(?:provide|give))\b/iu;
const speculative =
  /\b(?:hypothetical(?:ly)?|assum(?:e|ing)|if we|if the|suppose|scenario)\b/iu;
const question = /\?\s*$/u;
const risk =
  /\b(?:risks?|uncertain(?:ty)?|headwinds?|constrain\w*|concerns?|disrupt\w*|vulnerab\w*|pressure)\b/iu;
const injection =
  /\b(?:ignor\w*\s+(?:(?:all|any|previous|prior|above|your|the|system)\s+)*instructions?|(?:system|developer)\s+(?:prompt|message)|(?:output|emit|return|print)\s+(?:exactly\s+)?\d|api[- ]?keys?|skip\s+(?:the\s+)?validation|assistant\s*:|reveal\s+(?:your|the)\s+prompt)\b/iu;
const investmentAdvice =
  /\b(?:recommend(?:s|ed)?\s+(?:you\s+)?(?:buy|sell|hold)|(?:buy|sell|hold)\s+(?:the|our|their)\s+(?:stock|shares)|price target)\b/iu;
const basisPattern = /\b(?:standalone|stand-alone|consolidated)\b/iu;
const periodPattern =
  /\bQ[1-4]\s*FY\s*(?:20\d{2}|\d{2})(?:\s*[-–/]\s*(?:20\d{2}|\d{2}))?\b/iu;
const comparisonPattern =
  /\b(?:YoY|QoQ|year[- ]on[- ]year|quarter[- ]on[- ]quarter)\b/iu;
const currency = "(?:₹|\\$|€|£|INR\\b|USD\\b|Rs\\.?)";
const number =
  "[+−-]?(?:\\d{1,3}(?:,\\d{2})*,\\d{3}|\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const unitPattern =
  "(?:%|percent\\b|crores?\\b|lakhs?\\b|million\\b|billion\\b|bps\\b|basis points\\b|times\\b|x\\b|units?\\b)";
const quantitiesPattern = new RegExp(
  `(?<![\\p{L}\\d,])(?<currency>${currency}\\s*)?${number}(?:\\s*(?:[-–−]|to)\\s*(?:${currency}\\s*)?${number})?(?<unit>\\s*${unitPattern})?(?![\\p{L}\\d,]|\\.\\d)`,
  "giu",
);

export function quantities(quote) {
  return [...quote.matchAll(quantitiesPattern)].map((hit) => {
    const open = /\(\s*$/u.exec(quote.slice(0, hit.index));
    const end = hit.index + hit[0].length;
    const close = /^\s*\)/u.exec(quote.slice(end));
    // Retain accounting parentheses rather than projecting a printed loss as a positive figure.
    const printed =
      open && close ? quote.slice(open.index, end + close[0].length) : hit[0];
    return {
      value: normalizedQuote(printed),
      unit: hit.groups.unit?.trim() ?? hit.groups.currency?.trim() ?? null,
    };
  });
}

export const isManagement = (unit) =>
  ["management", "qa_answer"].includes(unit.kind);
export const isAnalyst = (unit) =>
  !/^(?:moderator|operator|host)\b/iu.test(unit.speaker ?? "") &&
  (unit.kind === "qa_question" ||
    /^(?:analyst|questioner)\b/iu.test(unit.speaker ?? "") ||
    (!isManagement(unit) && question.test(unit.text)));
export const isRisk = (text) => risk.test(text);
export const isInjection = (text) => injection.test(text);

/** Compare metrics by reporting context and printed value rather than page location. */
export const metricIdentity = (item) =>
  JSON.stringify([
    item.metric.name.toLowerCase(),
    item.period,
    item.metric.basis?.toLowerCase(),
    item.metric.comparison,
    item.metric.value_original,
    item.modality,
  ]);

export function modalityOf(unit) {
  if (isAnalyst(unit)) return "analyst_question";
  if (speculative.test(unit.text)) return "hypothetical";
  if (isManagement(unit) && future.test(unit.text) && !withheld.test(unit.text))
    return "forward_looking";
  return "historical";
}

const equals = (a, b) =>
  normalizedQuote(a).toLowerCase() === normalizedQuote(b).toLowerCase();
const includesPhrase = (source, value) => {
  const literal = normalizedQuote(value).replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(normalizedQuote(source));
};

export function metricClauses(quote) {
  return quote.split(
    /;|\s+and\s+(?=(?:the\s+)?(?:standalone|consolidated|Q[1-4]\s*FY)\b)/iu,
  );
}

/** Validate the numeric value and its label in the same unambiguous reporting clause. */
export function metricEvidence(quote, candidate) {
  for (const clause of metricClauses(quote)) {
    const values = quantities(clause);
    if (
      values.length !== 1 ||
      !equals(values[0].value, candidate.value_original) ||
      !includesPhrase(clause, candidate.name)
    )
      continue;
    const { value, unit } = values[0];
    const basis = basisPattern.exec(clause)?.[0] ?? null;
    const comparison = comparisonPattern.exec(clause)?.[0] ?? null;
    const period = periodPattern.exec(clause)?.[0] ?? null;
    const printedBases = [
      ...clause.matchAll(new RegExp(basisPattern.source, "giu")),
    ].map((hit) => hit[0].toLowerCase());
    if (new Set(printedBases).size > 1) continue;
    if (
      [
        [candidate.unit, unit],
        [candidate.basis, basis],
        [candidate.comparison, comparison],
      ].some(
        ([given, observed]) =>
          given !== null && (!observed || !equals(given, observed)),
      )
    )
      continue;
    return {
      metric: {
        name: candidate.name,
        value_original: value,
        unit,
        basis,
        comparison,
      },
      period,
    };
  }
  return null;
}

function checkFact(fact, unit, pages) {
  if (
    !unit ||
    unit.partial ||
    unit.page !== fact.source_page ||
    fact.source_block_ids[0] !== unit.block
  )
    return "invalid_location";
  if (
    normalizedQuote(fact.source_quote) !== unit.text ||
    !normalizedQuote(pages.get(unit.page) ?? "").includes(unit.text)
  )
    return "quote_mismatch";
  if (isInjection(unit.text)) return "instruction_in_source";
  if (investmentAdvice.test(unit.text)) return "investment_advice";
  // Extractive claims remove scope for negation loss, unsupported paraphrase, and invented numbers.
  if (normalizedQuote(fact.claim) !== unit.text) return "unsupported_claim";
  if (fact.speaker !== unit.speaker || fact.modality !== modalityOf(unit))
    return "attribution_or_modality";
  if (fact.category !== "metric" && fact.metric !== null)
    return "unexpected_metric";
  if (
    fact.category === "guidance" &&
    (!isManagement(unit) || fact.modality !== "forward_looking")
  )
    return "unsupported_guidance";
  if (fact.category === "commentary" && !isManagement(unit))
    return "unsupported_management_role";
  if (fact.category === "qa" && !isAnalyst(unit) && !isManagement(unit))
    return "unsupported_qa_role";
  if (
    fact.category === "risk" &&
    (!isManagement(unit) || !risk.test(unit.text))
  )
    return "unsupported_risk";
  if (
    fact.category === "segment" &&
    (!isManagement(unit) ||
      !fact.segment ||
      !/\bsegment\b/iu.test(unit.text) ||
      !includesPhrase(unit.text, fact.segment))
  )
    return "unsupported_segment";
  if (fact.category !== "segment" && fact.segment !== null)
    return "unexpected_segment";
  if (
    fact.category === "metric" &&
    (isAnalyst(unit) || (!isManagement(unit) && unit.kind !== "table"))
  )
    return "unsupported_metric_role";
  const binding = fact.metric ? metricEvidence(unit.text, fact.metric) : null;
  if (fact.metric && !binding) return "numeric_or_reporting_basis";
  const period = binding
    ? binding.period
    : (periodPattern.exec(unit.text)?.[0] ?? null);
  if (fact.period !== null && (!period || !equals(period, fact.period)))
    return "period_mismatch";
  return {
    ...fact,
    claim: unit.text,
    source_quote: unit.text,
    period,
    metric: binding?.metric ?? null,
  };
}

/** Reject bad map claims before synthesis; collapse overlap only when evidence and reporting context agree. */
export function verifyAndConsolidate(mapped, units, manifest) {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const pages = new Map(
    manifest.pages.map((page) => [page.page_number, page.cleaned_text]),
  );
  const facts = new Map();
  const rejected = Object.create(null);
  const metricValues = new Map();
  for (const fact of mapped) {
    const validated = checkFact(fact, unitById.get(fact.unit_id), pages);
    if (typeof validated === "string") {
      rejected[validated] = (rejected[validated] ?? 0) + 1;
      continue;
    }
    const {
      category,
      source_quote,
      source_page,
      source_block_ids,
      period,
      metric,
      modality,
      segment,
    } = validated;
    const key = JSON.stringify([
      category,
      source_quote,
      source_page,
      source_block_ids,
      period,
      metric,
      modality,
      segment,
    ]);
    if (facts.has(key)) continue;
    const id = `f-${sha256(key).slice(0, 24)}`;
    facts.set(key, { ...validated, fact_id: id });
    if (metric) {
      const group = JSON.stringify([
        metric.name.toLowerCase(),
        metric.basis?.toLowerCase(),
        period,
        metric.comparison,
        modality,
      ]);
      if (!metricValues.has(group)) metricValues.set(group, new Set());
      metricValues.get(group).add(metric.value_original);
    }
  }
  const conflicts = [...metricValues.values()].filter(
    (values) => values.size > 1,
  ).length;
  return { facts: [...facts.values()], rejected, conflicts };
}

/** Index only actual neighboring analyst and management turns, across pages if necessary. */
export function qaTurns(units) {
  const turns = new Map();
  for (const unit of units) {
    if (!turns.has(unit.block)) turns.set(unit.block, []);
    turns.get(unit.block).push(unit);
  }
  const groups = [...turns.values()];
  const pairs = new Map();
  for (let i = 0; i < groups.length - 1; i++) {
    const [next] = groups[i + 1];
    if (groups[i].some(isAnalyst) && groups[i + 1].every(isManagement))
      pairs.set(groups[i][0].block, next.block);
  }
  return { turns, pairs };
}
