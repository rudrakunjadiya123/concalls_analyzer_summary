import { qaHeading } from "../pdf/speakers.js";

/** Confirm transcript-like dialogue from document evidence and keep notice-only files out. */
export function classifyTranscript(extraction, filing) {
  const { pages, blocks, quality } = extraction;
  const early = pages
    .slice(0, 3)
    .map(({ cleaned_text }) => cleaned_text)
    .join("\n");
  const hasQaHeading = blocks.some(
    ({ kind, text }) => kind === "heading" && qaHeading.test(text),
  );
  const management = blocks.some(
    ({ kind }) => kind === "management" || kind === "qa_answer",
  );
  const question = blocks.some(
    ({ kind, text }) => kind === "qa_question" || /\?$/u.test(text.trim()),
  );
  const speakers = new Set(
    blocks.map(({ speaker }) => speaker).filter(Boolean),
  );
  const hasCall =
    /\b(?:earnings|quarterly|financial results|financial performance)\b/iu.test(
      early,
    ) && /\b(?:call|conference|transcript)\b/iu.test(early);
  const filingContext = /\b(?:earnings|conference|investor|analyst)\b/iu.test(
    `${filing.subject} ${filing.description}`,
  );
  const audioOnly = /\b(?:audio|video)\s+(?:recording|link)\b/iu.test(early);
  const coverOnly =
    /\b(?:cover(?:ing)? letter|dear sirs?|dear madam|hosted elsewhere|available on (?:the|our) website)\b/iu.test(
      early,
    );
  const invite =
    /\b(?:invitation|invite you|scheduled to be held|will be held|dial-in)\b/iu.test(
      early,
    );
  const presentation =
    /\b(?:investor presentation|earnings presentation|press release)\b/iu.test(
      early,
    );
  const signals = {
    earnings_context: hasCall,
    filing_context: filingContext,
    speaker_count: speakers.size,
    management_turns: management,
    question_turn: question,
    qa_heading: hasQaHeading,
  };
  const result = (classification, role, reason, confidence = "low") => ({
    classification,
    role,
    reason,
    confidence,
    signals,
  });
  if (!quality.text_pages || quality.suspected_scanned)
    return result(
      "needs_document",
      "unknown",
      quality.suspected_scanned ? "ocr_needed" : "PDF_TEXT_UNAVAILABLE",
    );
  if (
    (hasCall || (filingContext && /\b(?:call|transcript)\b/iu.test(early))) &&
    ((quality.speaker_turns >= 3 &&
      speakers.size >= 2 &&
      (management || question || hasQaHeading)) ||
      (hasQaHeading && quality.speaker_turns >= 2 && (management || question)))
  ) {
    return result(
      "confirmed_transcript",
      "transcript",
      "transcript_dialogue",
      quality.reading_order_confidence === "low" ||
        quality.replacement_characters > 0
        ? "medium"
        : "high",
    );
  }
  if (audioOnly)
    return result("unsupported", "other", "audio_only_waiting_transcript");
  if (coverOnly)
    return result(
      "needs_document",
      "cover_letter",
      "cover_letter_only",
      "high",
    );
  if (invite || presentation)
    return result(
      "excluded",
      "other",
      invite ? "invitation_only" : "presentation_only",
      "high",
    );
  if (hasCall || hasQaHeading)
    return result("needs_document", "unknown", "transcript_content_uncertain");
  return result("excluded", "other", "NOT_A_TRANSCRIPT");
}
