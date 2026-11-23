const moderator = /^(?:moderator|operator|host)(?:\s|$)/iu;
const management =
  /^(?:management|ceo|cfo|coo|chair(?:person|man|woman)?|(?:chief|managing)\s[\p{L} ]+)(?:\s|$)/iu;
const analyst = /^(?:analyst|questioner)(?:\s|$)/iu;
const honorific =
  /^(?:[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Dd]r)\.?\s+\p{Lu}[\p{L}\p{M}.'’ -]+$/u;
const named = /^\p{Lu}[\p{L}\p{M}.'’–-]*(?:\s+\p{Lu}[\p{L}\p{M}.'’–-]*){1,5}$/u;
const labelWords =
  /\b(?:revenue|margin|crore|income|quarter|growth|statement|results|discussion|remarks|report|earnings|transcript|call|limited|group|company|sector|readings|performance|capital|expenses)\b/iu;
export const qaHeading =
  /^(?:question\s*(?:and|&|\/)\s*answer(?:\s+session)?|questions\s*(?:and|&)\s*answers|q\s*(?:&|and|\/)\s*a(?:\s+session)?)\s*:?$/iu;
const heading =
  /^(?:prepared remarks|management remarks|opening remarks|participants|presentation|financial highlights)\s*:?$/iu;
const bullet = /^\s*(?:[•●▪*]|[-–]\s|\d+[.)]\s)/u;

function role(label) {
  if (moderator.test(label)) return "moderator";
  if (management.test(label)) return "management";
  if (analyst.test(label)) return "analyst";
  return null;
}

/** Recognize explicit speaker labels without interpreting numeric/time labels as names. */
export function speakerLabel(
  text,
  { allowStandalone = true, standaloneName = false } = {},
) {
  if (qaHeading.test(text) || heading.test(text)) return null;
  const inline = /^([^:\d]{1,84}):\s*(.*)$/u.exec(text);
  const label = (inline?.[1] ?? text).trim();
  const [person, explicitRole] = label.split(
    /\s+[–—-]\s+|\s+(?=\((?:analyst|ceo|cfo|coo|moderator)\)$)/iu,
  );
  const roleHint =
    role(person) ??
    (explicitRole ? role(explicitRole.replace(/^\(|\)$/gu, "")) : null);
  const plausibleName =
    honorific.test(person) ||
    ((Boolean(inline) || standaloneName) &&
      named.test(person) &&
      !labelWords.test(person));
  if (!roleHint && !plausibleName) return null;
  if (!inline && !allowStandalone) return null;
  return {
    name: roleHint && explicitRole ? person : label,
    role: roleHint,
    content: inline?.[2] ?? "",
  };
}

/** Build speaker turns with exact cleaned-line citations, including continuations across pages. */
export function buildBlocks(pages) {
  const blocks = [];
  let active;
  let inQa = false;
  let turns = 0;
  const flush = () => {
    if (active?.text) blocks.push(active);
    active = undefined;
  };
  const append = (line, page, number, kind, speaker, split = false) => {
    if (split || !active || active.kind !== kind || active.speaker !== speaker)
      flush();
    if (!active) {
      active = {
        block_id: `p${page}b${blocks.length + 1}`,
        page_start: page,
        page_end: page,
        speaker,
        kind,
        text: "",
        line_refs: [],
      };
    }
    active.text += (active.text && line ? " " : "") + line;
    active.page_end = page;
    active.line_refs.push({ page_number: page, line_number: number });
  };
  let participant = null;
  for (const page of pages) {
    const lines = page.lines;
    if (!lines.length) {
      flush();
      participant = null;
    }
    for (const [index, line] of lines.entries()) {
      const number = index + 1;
      const text = line.text;
      if (qaHeading.test(text) || heading.test(text)) {
        flush();
        participant = null;
        if (qaHeading.test(text)) inQa = true;
        append(text, page.page_number, number, "heading", null, true);
        flush();
        continue;
      }
      if (line.kind === "table") {
        append(text, page.page_number, number, "table", null, true);
        flush();
        continue;
      }
      const nextLine = lines[index + 1]?.text ?? "";
      const label = speakerLabel(text, {
        allowStandalone:
          index + 1 < lines.length ||
          Boolean(pages[page.page_number]?.lines.length),
        // A plain name on its own line needs nearby dialogue and a known Q&A boundary.
        standaloneName:
          inQa &&
          nextLine.split(/\s+/u).length >= 5 &&
          /[.,?]$/u.test(nextLine),
      });
      if (label) {
        flush();
        participant = label;
        turns++;
      }
      const content = label?.content ?? text;
      const questionText = content || nextLine;
      const question =
        /\?$/u.test(questionText) ||
        /^(?:could|can|would|what|why|how|when|where|is|are|do|does|did)\b/iu.test(
          questionText,
        );
      const kind =
        participant?.role === "analyst" && (question || inQa)
          ? "qa_question"
          : participant?.role === "management"
            ? inQa
              ? "qa_answer"
              : "management"
            : participant?.role !== "moderator" &&
                inQa &&
                participant &&
                (question || active?.kind === "qa_question")
              ? "qa_question"
              : "unattributed";
      const discontinuity =
        !participant &&
        active &&
        (active.page_end !== page.page_number ||
          (index > 0 && Math.abs(line.y - lines[index - 1].y) > 28));
      append(
        content,
        page.page_number,
        number,
        kind,
        participant?.name ?? null,
        bullet.test(text) || discontinuity,
      );
    }
  }
  flush();
  return { blocks, turns };
}
