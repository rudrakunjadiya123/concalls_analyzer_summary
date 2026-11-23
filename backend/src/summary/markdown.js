import { summarySchema } from "@finosauras/shared";
import { parseSourceUrl } from "../core/security.js";

function escape(value) {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()|]/gu, "\\$&")
    .replace(
      /\b(?:https?|javascript|data|file):/giu,
      (prefix) => prefix.slice(0, -1) + "&#58;",
    );
}

function safeUrl(value) {
  if (!value) return null;
  try {
    return parseSourceUrl(value)
      .href.replaceAll("(", "%28")
      .replaceAll(")", "%29");
  } catch {
    return null;
  }
}
const unavailable = "_Not identified in the available transcript._";
const bullets = (items) =>
  items.length
    ? items.map((item) => `- ${escape(item)}`).join("\n")
    : unavailable;

/** Render assignment JSON deterministically using only escaped content and the vetted provenance link. */
export function renderMarkdown(input, { isMock = false } = {}) {
  const summary = summarySchema.parse(input);
  const url = safeUrl(summary.source_url);
  const metrics = summary.key_metrics.length
    ? [
        "| Metric | Value | Context |",
        "| --- | --- | --- |",
        ...summary.key_metrics.map(
          ({ metric, value, context }) =>
            `| ${escape(metric)} | ${escape(value)} | ${escape(context)} |`,
        ),
      ].join("\n")
    : unavailable;
  const segment = summary.segment_performance
    .map(
      ({ segment: name, notes }) => `- **${escape(name)}:** ${escape(notes)}`,
    )
    .join("\n");
  const qa = summary.notable_qa
    .map(
      ({ question, answer, asked_by: by }) =>
        `**Question (${by ? escape(by) : "Analyst not identified"}):** ${escape(question)}  \n**Management response:** ${escape(answer)}`,
    )
    .join("\n\n");
  return (
    [
      `# ${escape(summary.company)} — ${summary.quarter ? escape(summary.quarter) : "Quarter not confirmed"}`,
      ...(isMock
        ? ["**Synthetic fixture · mock output.**"]
        : summary.source === "FIXTURE"
          ? ["**Synthetic fixture · Gemini output.**"]
          : []),
      `**Call date:** ${summary.call_date ?? "Not confirmed"}  \n**Source:** ${summary.source}${url ? ` · [Original filing](${url})` : ""}`,
      `## TL;DR\n\n${bullets(summary.tldr)}`,
      `## Management commentary\n\n${bullets(summary.management_commentary)}`,
      `## Guidance and outlook\n\n${summary.guidance.length ? bullets(summary.guidance) : "_Not stated in the available transcript._"}`,
      `## Segment performance\n\n${segment || unavailable}`,
      `## Key metrics\n\n${metrics}`,
      `## Notable analyst Q&A\n\n${qa || unavailable}`,
      `## Risks and concerns\n\n${bullets(summary.risks)}`,
      "_Generated from the transcript. Verify significant financial figures against the original filing._",
    ].join("\n\n") + "\n"
  );
}
