const executive =
  /^(?:(?:group |global )?chief (?:executive|financial|operating|technology) officer|managing director|executive director|C[EFOT]O\b)/iu;
const person =
  /^(?:[\p{Lu}][\p{L}\p{M}.'’-]*\s+){1,5}[\p{Lu}][\p{L}\p{M}.'’-]*$/u;
const roleKey = (text) => text.toLowerCase().replace(/[^a-z]/gu, "");
const labelKey = (name) => name.toLowerCase().trim().replace(/\s+/gu, " ");
const refKey = (page, line) => page + ":" + line;

/** Attribute standalone dialogue labels only when the printed participant roster identifies them. */
export function rosterDialogue(pages) {
  const management = new Map();
  const hosts = new Map();
  const rosterPages = new Set();
  for (const page of pages) {
    const heading = page.lines
      .slice(0, 12)
      .findIndex(({ text }) =>
        ["corporateparticipants", "managementparticipants"].includes(
          roleKey(text),
        ),
      );
    if (heading < 0) continue;
    rosterPages.add(page.page_number);
    for (let index = heading + 1; index < page.lines.length - 1; index++) {
      const { text } = page.lines[index];
      const { text: role } = page.lines[index + 1];
      if (["analysts", "journalists", "investors"].includes(roleKey(text)))
        break;
      const name = text.replace(/\s+\((?:emcee|host|moderator)\)$/iu, "");
      if (!person.test(name)) continue;
      if (executive.test(role)) management.set(labelKey(name), name);
      if (
        name !== text ||
        /^(?:corporate communications|financial controller.*head investor relations)\b/iu.test(
          role,
        )
      )
        hosts.set(labelKey(name), name);
    }
  }
  if (!management.size) return null;

  const label = (text, names) => {
    const [name, spoken] = text.split(/:\s*/u, 2);
    const speaker = names.get(labelKey(name));
    if (!speaker) return null;
    return {
      speaker,
      content:
        spoken === undefined ? "" : text.slice(text.indexOf(":") + 1).trim(),
    };
  };
  const moderator = /^(?:moderator|operator)(?:\s*:\s*|$)/iu;
  const speakers = new Map([...management, ...hosts]);
  // A roster sometimes continues on the page before the first spoken turn.
  for (const start of [...rosterPages]) {
    for (const page of pages.slice(start, start + 2)) {
      if (
        page.lines.some(
          ({ text }) => moderator.test(text) || label(text, speakers),
        )
      )
        break;
      rosterPages.add(page.page_number);
    }
  }
  const analysts = new Map();
  let introductions = "";
  let hosting = false;
  for (const page of pages) {
    if (rosterPages.has(page.page_number)) {
      hosting = false;
      introductions += "\n";
      continue;
    }
    for (const { text } of page.lines) {
      const host = label(text, hosts);
      if (host || moderator.test(text)) {
        hosting = true;
        introductions += "\n" + (host?.content ?? text.replace(moderator, ""));
      } else if (label(text, management) || person.test(text)) {
        hosting = false;
      } else if (hosting) {
        introductions += " " + text;
      }
    }
  }
  for (const hit of introductions.matchAll(
    /\b(?:next|first) question (?:comes |is )?from (?:the line of )?(.+?) (?:from|with) /giu,
  )) {
    const name = hit[1].trim();
    if (
      person.test(name) &&
      !management.has(labelKey(name)) &&
      !hosts.has(labelKey(name))
    )
      analysts.set(labelKey(name), name);
  }

  let turn = null;
  const lines = new Map();
  for (const page of pages) {
    if (rosterPages.has(page.page_number)) {
      turn = null;
      continue;
    }
    for (const [index, { text }] of page.lines.entries()) {
      const key = refKey(page.page_number, index + 1);
      const participant = label(text, management);
      const analyst = label(text, analysts);
      const host = label(text, hosts);
      const matched = participant ?? analyst ?? host;
      if (matched) {
        turn = {
          speaker: matched.speaker,
          kind: participant
            ? "management"
            : analyst
              ? "qa_question"
              : "unattributed",
          turn: key,
        };
        lines.set(key, { ...turn, content: matched.content });
      } else if (turn) {
        // An unrecognized standalone name ends the current turn until its role can be verified.
        if (
          person.test(text) ||
          /^(?:moderator|operator|host)\s*:?\s*$/iu.test(text)
        )
          turn = null;
        else lines.set(key, { ...turn, content: text });
      }
    }
  }
  return { rosterPages, lines };
}
