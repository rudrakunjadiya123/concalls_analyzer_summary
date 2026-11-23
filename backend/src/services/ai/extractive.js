import {
  isAnalyst,
  isInjection,
  isManagement,
  isRisk,
  metricIdentity,
  metricClauses,
  metricEvidence,
  modalityOf,
  quantities,
} from "./evidence.js";

const metricNames =
  /\b(?:operating margin|operating profit|free cash flow|order book|net profit|revenue|ebitda|earnings|growth|margin|capex)\b/iu;
const segmentName =
  /\b(\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*){0,2})\s+[Ss]egment\b/u;

/** Derive structured candidates from citable transcript units without generating claims. */
export function extractTranscriptFacts({ chunk }) {
  const facts = [];
  function add(unit, category, fields = {}) {
    facts.push({
      fact_id: `extractive-${facts.length + 1}`,
      unit_id: unit.id,
      category,
      claim: unit.text,
      source_quote: unit.text,
      source_page: unit.page,
      source_block_ids: [unit.block],
      speaker: unit.speaker,
      period: null,
      metric: null,
      segment: null,
      modality: modalityOf(unit),
      extraction_confidence: "high",
      ...fields,
    });
  }
  for (const unit of chunk.units) {
    if (unit.partial || isInjection(unit.text)) continue;
    if (isAnalyst(unit)) {
      add(unit, "qa");
      continue;
    }
    const management = isManagement(unit);
    if (management) add(unit, "commentary");
    if (unit.kind === "qa_answer") add(unit, "qa");
    if (management && modalityOf(unit) === "forward_looking")
      add(unit, "guidance");
    if (management && isRisk(unit.text)) add(unit, "risk");
    const segment = segmentName.exec(unit.text)?.[1];
    if (management && segment) add(unit, "segment", { segment });
    if (management || unit.kind === "table") {
      for (const clause of metricClauses(unit.text)) {
        const value = quantities(clause)[0]?.value;
        const name = metricNames.exec(clause)?.[0];
        if (!value || !name) continue;
        const binding = metricEvidence(unit.text, {
          name,
          value_original: value,
          unit: null,
          basis: null,
          comparison: null,
        });
        if (binding) add(unit, "metric", binding);
      }
    }
  }
  return { facts: facts.slice(0, 80) };
}

/** Select supported sections and highlights from validated facts. */
export function selectTranscriptFacts({ verifiedFacts, qaOptions }) {
  const pick = (category, max) => {
    const group = verifiedFacts.filter(
      (fact) =>
        fact.category === category &&
        fact.modality !== "analyst_question" &&
        (category === "commentary" || fact.modality !== "hypothetical"),
    );
    const kept =
      group.length > max ? [...group.slice(0, max - 1), group.at(-1)] : group;
    return kept.map(({ fact_id }) => fact_id);
  };
  const candidates = [...verifiedFacts].sort(
    (a, b) =>
      ["metric", "guidance", "risk", "segment", "commentary", "qa"].indexOf(
        a.category,
      ) -
      ["metric", "guidance", "risk", "segment", "commentary", "qa"].indexOf(
        b.category,
      ),
  );
  const tldr = [];
  const seen = new Set();
  const add = (fact) => {
    if (
      !fact ||
      fact.claim.split(/\s+/u).length < 4 ||
      ["hypothetical", "analyst_question"].includes(fact.modality) ||
      seen.has(fact.claim)
    )
      return;
    tldr.push(fact.fact_id);
    seen.add(fact.claim);
  };
  for (const category of [
    "metric",
    "guidance",
    "risk",
    "segment",
    "commentary",
  ]) {
    add(
      candidates.find(
        (fact) => fact.category === category && !seen.has(fact.claim),
      ),
    );
  }
  if (tldr.length < 3)
    for (const fact of candidates) {
      add(fact);
      if (tldr.length >= 3) break;
    }
  return {
    tldr,
    management_commentary: pick("commentary", 12),
    guidance: pick("guidance", 12),
    segment_performance: pick("segment", 12),
    key_metrics: [
      ...new Map(
        verifiedFacts
          .filter(
            (fact) =>
              fact.category === "metric" &&
              !["hypothetical", "analyst_question"].includes(fact.modality),
          )
          .map((fact) => [metricIdentity(fact), fact.fact_id]),
      ).values(),
    ].slice(0, 20),
    notable_qa:
      qaOptions.length > 10
        ? [...qaOptions.slice(0, 9), qaOptions.at(-1)]
        : qaOptions,
    risks: pick("risk", 12),
  };
}
