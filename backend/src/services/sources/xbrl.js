import { SaxesParser } from "saxes";
import { normalizedFilingSchema } from "@finosauras/shared";
import {
  isCallUpdateSubject,
  matchesTranscriptAnnouncement,
} from "../ingestion/eligibility.js";
import { PipelineError } from "../../utils/errors.js";
import { attachment } from "./normalize.js";

const facts = new Map([
  ["subject", "subject"],
  ["description", "description"],
  ["details", "description"],
  ["isin", "isin"],
  ["calldate", "callDateHint"],
  ["quarter", "quarterHint"],
  ["pdfurl", "pdf"],
  ["transcripturl", "pdf"],
]);

/** Read announcement facts without loading schemas, external entities or other resources. */
function announcementFacts(xml) {
  const parser = new SaxesParser();
  const values = {};
  let depth = 0;
  let fact;
  const invalid = () => {
    throw new PipelineError("SOURCE_SCHEMA_CHANGED");
  };
  parser.on("doctype", invalid);
  parser.on("error", invalid);
  parser.on("opentag", ({ name }) => {
    const key = name.split(":").at(-1).toLowerCase();
    depth++;
    if (depth > 64 || (depth === 1 && key !== "xbrl")) invalid();
    if (depth === 2 && facts.has(key))
      fact = { key: facts.get(key), value: "" };
  });
  const collect = (text) => {
    if (fact) fact.value += text;
  };
  parser.on("text", collect);
  parser.on("cdata", collect);
  parser.on("closetag", () => {
    if (depth-- !== 2 || !fact) return;
    const value = fact.value.trim();
    if (value) {
      if (values[fact.key] && values[fact.key] !== value) invalid();
      values[fact.key] = value;
    }
    fact = undefined;
  });
  parser.write(xml).close();
  return values;
}

export function createAnnouncementReview({
  client,
  allowedAttachment,
  logger,
}) {
  return async (filing, { signal }) => {
    if (!isCallUpdateSubject(filing.subject)) return null;
    const xbrl = filing.attachments.find(({ kindHint }) => kindHint === "xbrl");
    // Transcript rows can list a PDF and the required metadata with an empty XBRL column.
    if (!xbrl) return matchesTranscriptAnnouncement(filing) ? filing : null;
    if (!allowedAttachment(xbrl.url)) {
      logger?.warn("announcement_xbrl_skipped", {
        stage: "source",
        source: filing.source,
        error_code: "DOWNLOAD_UNSAFE_URL",
      });
      return null;
    }
    try {
      const fields = announcementFacts(await client.xml(xbrl.url, { signal }));
      if (
        fields.isin &&
        filing.company.isin &&
        fields.isin !== filing.company.isin
      )
        throw new PipelineError("COMPANY_IDENTITY_CONFLICT");
      const pdf = attachment(fields.pdf);
      const attachments =
        filing.attachments.some(({ kindHint }) => kindHint === "pdf") ||
        pdf?.kindHint !== "pdf"
          ? filing.attachments
          : [...filing.attachments, pdf];
      const candidate = normalizedFilingSchema.safeParse({
        ...filing,
        subject: fields.subject ?? filing.subject,
        description: fields.description ?? filing.description,
        company: {
          ...filing.company,
          isin: fields.isin ?? filing.company.isin,
        },
        callDateHint: fields.callDateHint ?? filing.callDateHint,
        quarterHint: fields.quarterHint ?? filing.quarterHint,
        attachments,
      });
      if (!candidate.success) throw new PipelineError("SOURCE_SCHEMA_CHANGED");
      return matchesTranscriptAnnouncement(candidate.data)
        ? candidate.data
        : null;
    } catch (error) {
      if (
        signal?.aborted ||
        ![
          "SOURCE_SCHEMA_CHANGED",
          "COMPANY_IDENTITY_CONFLICT",
          "DOWNLOAD_UNSAFE_URL",
        ].includes(error.code)
      )
        throw error;
      logger?.warn("announcement_xbrl_skipped", {
        stage: "source",
        source: filing.source,
        error_code: error.code,
      });
      return null;
    }
  };
}
