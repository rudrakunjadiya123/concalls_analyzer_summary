const moderator = /^(?:moderator|operator|host)\b/iu;
const opening = /^(.{2,64}?)[’']s opening remarks\s*:?$/iu;
const person =
  /^(?:(?:[Mm]r|[Mm]rs|[Mm]s|[Dd]r)\.?\s+)?[\p{Lu}][\p{L}\p{M}.'’-]*(?: [\p{Lu}][\p{L}\p{M}.'’-]*){0,4}$/u;
const normalize = (value) => value.replace(/\s+/gu, " ").trim();
const nameParts = (value) =>
  value
    .replace(/^(?:mr|mrs|ms|dr)\.?\s+/iu, "")
    .toLowerCase()
    .split(/\s+/u);

function matchingName(shorthand, candidates) {
  const parts = nameParts(shorthand);
  const short = parts.join(" ");
  const matches = candidates.filter((name) => {
    const full = nameParts(name);
    return (
      full.join(" ") === short ||
      (parts.length === 1 && [full[0], full.at(-1)].includes(short))
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Recognize explicit handoffs and Q&A introductions without altering the stored page map. */
export function discussionLayout(manifest, { legacyHandoffs = false } = {}) {
  const moderatorBlocks = manifest.blocks.filter(({ speaker }) =>
    moderator.test(speaker ?? ""),
  );
  const start = moderatorBlocks.find(
    ({ page_start, text }) =>
      page_start <= 3 &&
      /\bwelcome\b.*\b(?:call|conference)\b/iu.test(normalize(text)),
  );
  // Restrict front-matter exclusion to confirmed cover letters or legal boilerplate.
  const intro = manifest.pages
    .slice(0, start?.page_start ?? 0)
    .map(({ cleaned_text }) => cleaned_text)
    .join(" ");
  const firstBlock =
    start &&
    /\b(?:listing department|dear sir\/madam|safe harbor)\b/iu.test(intro)
      ? manifest.blocks.indexOf(start)
      : 0;
  const analysts = new Set();
  for (const block of moderatorBlocks) {
    const announced =
      /\bquestion (?:comes |is )?from (?:the line of )?(.+?)(?:\s+(?:from|with)\s+|[.!]|$)/iu.exec(
        normalize(block.text),
      )?.[1];
    if (announced && person.test(announced)) analysts.add(announced);
  }
  const labels = [
    ...new Set(
      manifest.blocks
        .map(({ speaker }) => speaker)
        .filter(
          (name) =>
            name &&
            person.test(name) &&
            nameParts(name).length > 1 &&
            !moderator.test(name),
        ),
    ),
  ];
  const management = new Set();
  const prepared = new Map();
  let previous = "";
  let current = null;
  let inQa = false;
  for (const [index, block] of manifest.blocks.entries()) {
    if (index < firstBlock) continue;
    if (
      moderator.test(block.speaker ?? "") &&
      /\bquestion[-\s]+and[-\s]+answer (?:session|portion)\b|(?:question (?:comes |is )?from)/iu.test(
        normalize(block.text),
      )
    )
      inQa = true;
    for (const ref of block.line_refs) {
      const line =
        manifest.pages[ref.page_number - 1].lines[ref.line_number - 1].text;
      const heading = opening.exec(line);
      if (!inQa && heading) {
        const handoff =
          /\bhand\b[\s\S]{0,60}?\bover to (.+?)(?=\s+[-–—:,]|[.!](?:\s|$)|$)/giu;
        const introduction = legacyHandoffs
          ? previous
          : previous.replace(/\b(Mr|Mrs|Ms|Dr)\.\s+(?=\p{Lu})/gu, "$1 ");
        const named = [...introduction.matchAll(handoff)].at(-1)?.[1]?.trim();
        const direct =
          named && person.test(named)
            ? matchingName(heading[1], [named])
            : null;
        const name =
          direct &&
          (matchingName(direct, labels) ??
            (nameParts(direct).length > 1 ? direct : null));
        current = name && !matchingName(name, [...analysts]) ? name : null;
        if (current) management.add(current);
      }
      if (!inQa && current && !moderator.test(block.speaker ?? ""))
        prepared.set(ref, { speaker: current, heading: Boolean(heading) });
      previous = normalize(`${previous} ${line}`).slice(-400);
    }
  }
  return { firstBlock, prepared, analysts, management };
}
