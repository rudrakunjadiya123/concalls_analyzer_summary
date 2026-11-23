import { summarySchema } from "@finosauras/shared";
import { PipelineError } from "../core/errors.js";
import { estimateTokens } from "../ai/chunk.js";
import {
  isAnalyst,
  isManagement,
  metricIdentity,
  qaTurns,
  verifyAndConsolidate,
} from "../ai/evidence.js";
import { selectionSchema } from "../ai/contracts.js";

const error = (code = "AI_EVIDENCE_UNSUPPORTED") =>
  new PipelineError(code, undefined, { stage: "ai" });

function assembleOptions(facts, units) {
  const byUnit = new Map(
    facts
      .filter(({ category }) => category === "qa")
      .map((fact) => [fact.unit_id, fact.fact_id]),
  );
  const { turns, pairs } = qaTurns(units);
  const options = [];
  for (const [question, answer] of pairs) {
    const questionIds = turns.get(question).map(({ id }) => byUnit.get(id));
    const answerIds = turns.get(answer).map(({ id }) => byUnit.get(id));
    if (
      questionIds.length <= 8 &&
      answerIds.length <= 8 &&
      questionIds.every(Boolean) &&
      answerIds.every(Boolean)
    )
      options.push({ question_ids: questionIds, answer_ids: answerIds });
  }
  return options;
}

export function synthesisInput(mapped, units, manifest) {
  const checked = verifyAndConsolidate(mapped, units, manifest);
  const eligible = new Set(
    checked.facts
      .filter(
        ({ modality, claim }) =>
          !["analyst_question", "hypothetical"].includes(modality) &&
          claim.split(/\s+/u).length >= 4,
      )
      .map(({ claim }) => claim),
  );
  if (eligible.size < 3) throw error("AI_INSUFFICIENT_EVIDENCE");
  return { ...checked, qaOptions: assembleOptions(checked.facts, units) };
}

const attributed = (fact) =>
  `${fact.modality === "forward_looking" ? "Forward-looking — " : ""}${fact.speaker ? `${fact.speaker}: ` : ""}${fact.claim}`;
const eligibleSection = (category, { modality }) =>
  modality !== "analyst_question" &&
  (category === "commentary" || modality !== "hypothetical");

/** Rebuild the public object from validated ID selections; summary fields can never carry model-authored prose. */
export function verifySelection(
  selection,
  { facts, qaOptions, rejected, conflicts },
  units,
  trusted,
  { maxOutput = 12_000 } = {},
) {
  const parsed = selectionSchema.safeParse(selection);
  if (!parsed.success) throw error("AI_SCHEMA_INVALID");
  const selected = parsed.data;
  const byId = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const byUnit = new Map(units.map((unit) => [unit.id, unit]));
  const rows = [];
  const warnings = [...trusted.warnings];
  const coverage = {};
  if (conflicts) warnings.push("conflicting_metrics_retained_with_context");
  if (Object.keys(rejected).length)
    warnings.push("unsupported_map_facts_removed");
  function fact(id) {
    const item = byId.get(id);
    if (!item) throw error();
    return item;
  }
  function evidence(path, items) {
    for (const item of items)
      rows.push({
        claim_path: path,
        page_number: item.source_page,
        speaker: item.speaker,
        supporting_quote: item.source_quote,
        source_block_id: item.source_block_ids[0],
      });
  }
  const tldrFacts = selected.tldr.map(fact);
  if (
    new Set(tldrFacts.map(({ claim }) => claim)).size !== tldrFacts.length ||
    tldrFacts.some(
      ({ modality, claim }) =>
        ["analyst_question", "hypothetical"].includes(modality) ||
        claim.split(/\s+/u).length < 4,
    )
  )
    throw error();
  const tldr = tldrFacts.map((item, index) => {
    evidence(`tldr[${index}]`, [item]);
    return attributed(item);
  });

  function section(name, category, render) {
    const available = facts.filter(
      (item) => item.category === category && eligibleSection(category, item),
    );
    const ids = selected[name];
    if (new Set(ids).size !== ids.length || (available.length && !ids.length))
      throw error();
    coverage[name] = { available: available.length, included: ids.length };
    if (ids.length < available.length) warnings.push(`omitted_${name}`);
    return ids.map((id, index) => {
      const item = fact(id);
      if (item.category !== category || !eligibleSection(category, item))
        throw error();
      return render(item, `${name}[${index}]`);
    });
  }
  const text = (item, path) => {
    evidence(path, [item]);
    return attributed(item);
  };
  const management_commentary = section(
    "management_commentary",
    "commentary",
    text,
  );
  const guidance = section("guidance", "guidance", text);
  const risks = section("risks", "risk", text);
  const segment_performance = section(
    "segment_performance",
    "segment",
    (item, path) => {
      evidence(`${path}.segment`, [item]);
      evidence(`${path}.notes`, [item]);
      return { segment: item.segment, notes: attributed(item) };
    },
  );
  const key_metrics = section("key_metrics", "metric", (item, path) => {
    for (const field of ["metric", "value", "context"])
      evidence(`${path}.${field}`, [item]);
    return {
      metric: item.metric.name,
      value: item.metric.value_original,
      context: attributed(item),
    };
  });
  // Preserve distinct periods, bases and conflicting values when the result fits the metric cap.
  const availableMetrics = new Set(
    facts
      .filter(
        (item) => item.category === "metric" && eligibleSection("metric", item),
      )
      .map(metricIdentity),
  );
  const selectedMetrics = new Set(
    selected.key_metrics.map((id) => metricIdentity(fact(id))),
  );
  if (selectedMetrics.size < Math.min(availableMetrics.size, 20)) throw error();
  const allowedPairs = new Set(qaOptions.map((pair) => JSON.stringify(pair)));
  const uniquePairs = new Set(
    selected.notable_qa.map((pair) => JSON.stringify(pair)),
  );
  if (
    uniquePairs.size !== selected.notable_qa.length ||
    (qaOptions.length && !uniquePairs.size)
  )
    throw error();
  coverage.notable_qa = {
    available: qaOptions.length,
    included: uniquePairs.size,
  };
  if (uniquePairs.size < qaOptions.length) warnings.push("omitted_notable_qa");
  const notable_qa = selected.notable_qa.map((pair, index) => {
    if (!allowedPairs.has(JSON.stringify(pair))) throw error();
    const questions = pair.question_ids.map(fact);
    const answers = pair.answer_ids.map(fact);
    if (
      !questions.some((item) => isAnalyst(byUnit.get(item.unit_id))) ||
      !answers.every((item) => isManagement(byUnit.get(item.unit_id)))
    )
      throw error();
    const label = questions[0].speaker;
    const askedBy =
      !label || /^(?:analyst|questioner)(?:\s+\d+)?$/iu.test(label)
        ? null
        : label;
    evidence(`notable_qa[${index}].question`, questions);
    evidence(`notable_qa[${index}].answer`, answers);
    if (askedBy) evidence(`notable_qa[${index}].asked_by`, [questions[0]]);
    return {
      question: questions.map(({ claim }) => claim).join(" "),
      answer: answers.map(({ claim }) => claim).join(" "),
      asked_by: askedBy,
    };
  });
  const summary = summarySchema.safeParse({
    ...trusted.metadata,
    tldr,
    management_commentary,
    guidance,
    segment_performance,
    key_metrics,
    notable_qa,
    risks,
  });
  if (!summary.success) throw error("AI_SCHEMA_INVALID");
  if (estimateTokens(summary.data) > maxOutput) throw error("AI_CONTEXT_LIMIT");
  return {
    summary: summary.data,
    evidence: rows,
    report: { warnings: [...new Set(warnings)], rejected, coverage },
  };
}
