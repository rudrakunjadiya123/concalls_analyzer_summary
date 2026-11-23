const transcript = /\btranscripts?\b/u;
const call =
  /\b(?:earnings|results?|con(?:ference)? ?calls?|investor|analyst|quarterly)\b/u;
const negative =
  /\b(?:invitation|schedule|scheduled|investor presentation|board meeting|press release|audio recording|financial results)\b/u;
const audio = /\b(?:audio|video)\b/u;
const correction =
  /\b(?:revised|revision|corrected|correction|corrigendum|updated transcript)\b/u;
const cover =
  /\b(?:cover(?:ing)? letter|available on (?:our|the) website|hosted on (?:our|the) website)\b/u;
const words = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Find plausible PDFs using all feed metadata. Stage 3 determines actual PDF content. */
export function classifyFiling(filing, canDownload = () => true) {
  const title = words(filing.subject);
  const details = words(
    [filing.description, filing.category, filing.subcategory].join(" "),
  );
  const names = filing.attachments.map(({ filename }) => words(filename));
  // Filename-only notices still need review when the provider has no approved attachment base.
  const combined = [
    title,
    details,
    words(filing.raw?.ATTACHMENTNAME),
    ...names,
  ].join(" ");
  const positive =
    transcript.test(combined) &&
    (call.test(combined) || names.some((name) => transcript.test(name)));
  const hasNegative = negative.test(combined);
  const revised = correction.test(combined);
  const pdfs = filing.attachments
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.kindHint === "pdf" && canDownload(item.url));
  const hasNamedTranscript = pdfs.some(({ index }) =>
    transcript.test(names[index]),
  );
  const targets = hasNamedTranscript
    ? pdfs.filter(
        ({ index }) =>
          transcript.test(names[index]) || cover.test(names[index]),
      )
    : pdfs;

  if (
    !targets.length &&
    (filing.attachments.some(({ kindHint }) => kindHint === "audio") ||
      (audio.test(combined) && call.test(combined)))
  )
    return {
      classification: "unsupported",
      reason: "audio_only_waiting_transcript",
      targets: [],
      revised,
    };
  if (!positive)
    return {
      classification: "excluded",
      reason: hasNegative
        ? "non_transcript_disclosure"
        : "no_transcript_signal",
      targets: [],
      revised,
    };
  if (!targets.length)
    return {
      classification: "needs_document",
      reason: "no_approved_transcript_pdf",
      targets: [],
      revised,
    };
  // A future transcript mentioned only in an invitation is weaker than a named PDF.
  if (
    !hasNamedTranscript &&
    /\b(?:invitation|schedule|scheduled)\b/u.test(title) &&
    /\b(?:will be|to be|once available)\b/u.test(details)
  )
    return {
      classification: "excluded",
      reason: "future_transcript_notice",
      targets: [],
      revised,
    };
  return {
    classification: "candidate",
    targets,
    revised,
    reason: revised
      ? "correction_candidate"
      : cover.test(combined)
        ? "cover_letter_candidate"
        : hasNegative
          ? "conflicting_metadata_inspect_pdf"
          : "transcript_metadata",
  };
}
