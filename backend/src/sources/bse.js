import { z } from "zod";
import {
  attachment,
  clean,
  incomplete,
  normalized,
  optionalId,
  optionalText,
  publicationTime,
  queryDate,
  read,
  safePublicLink,
} from "./normalize.js";

const rowSchema = z
  .looseObject({
    NEWSID: optionalId,
    SCRIP_CD: z.union([z.string(), z.int().nonnegative()]),
    SLONGNAME: optionalText,
    ISIN: optionalText,
    NEWSSUB: optionalText,
    HEADLINE: optionalText,
    CATEGORYNAME: optionalText,
    SUBCATNAME: optionalText,
    NEWS_DT: optionalText,
    DissemDT: optionalText,
    DT_TM: optionalText,
    ATTACHMENTNAME: optionalText,
    ATTACHMENT_URL: optionalText,
    AUDIO_VIDEO_FILE: optionalText,
    PDFFLAG: z.union([z.string(), z.int(), z.boolean()]).nullish(),
    sourceUrl: optionalText,
  })
  .refine((row) => Boolean(clean(row.NEWSSUB) || clean(row.HEADLINE)));
const pageSchema = z.looseObject({
  Table: z.array(rowSchema),
  Table1: z.unknown().optional(),
});
const totals = z.tuple([
  z.looseObject({
    ROWCNT: z.union([
      z.int().nonnegative(),
      z.string().regex(/^\d+$/u).transform(Number).pipe(z.int().nonnegative()),
    ]),
  }),
]);

function safeAttachmentName(name) {
  return (
    name &&
    /^[\p{L}\p{N}_ -][\p{L}\p{N}_. -]{0,253}$/u.test(name) &&
    !name.endsWith(".") &&
    !name.includes("..")
  );
}

/** Resolve only a plain filename against an operator-approved BSE attachment directory. */
function bseAttachments(row, base) {
  const name = clean(row.ATTACHMENTNAME);
  const knownName = safeAttachmentName(name) ? name : undefined;
  let originalLink = safePublicLink(row.ATTACHMENT_URL) ?? safePublicLink(name);
  if (!originalLink && knownName && base) {
    const dir = new URL(base);
    dir.pathname = dir.pathname.replace(/\/?$/u, "/");
    originalLink = new URL(encodeURIComponent(knownName), dir).href;
  }
  const hint = [true, 1, "1", "Y", "y", "true"].includes(row.PDFFLAG)
    ? "pdf"
    : undefined;
  return [
    attachment(originalLink, knownName, hint),
    attachment(row.AUDIO_VIDEO_FILE, undefined, "audio"),
  ].filter(Boolean);
}

/** Normalize a BSE row independently from the NSE field contract. */
export function normalizeBse(
  row,
  { company, requestUrl, attachmentBase, logger },
) {
  const attachments = bseAttachments(row, attachmentBase);
  return normalized(
    "BSE",
    {
      sourceFilingId: row.NEWSID,
      company: {
        displayName:
          clean(row.SLONGNAME) ??
          company?.displayName ??
          String(row.SCRIP_CD).trim(),
        nseSymbol: null,
        bseScripCode: String(row.SCRIP_CD).trim(),
        isin: clean(row.ISIN),
      },
      subject: clean(row.NEWSSUB) ?? clean(row.HEADLINE),
      description: row.HEADLINE ?? "",
      category: clean(row.CATEGORYNAME),
      subcategory: clean(row.SUBCATNAME),
      publishedAt: publicationTime(
        clean(row.NEWS_DT) ?? clean(row.DissemDT) ?? clean(row.DT_TM),
      ),
      sourceUrl:
        safePublicLink(row.sourceUrl) ??
        attachments[0]?.url ??
        `${requestUrl.origin}${requestUrl.pathname}`,
      attachments,
      raw: row,
    },
    company,
    logger,
  );
}

/** Discover BSE pages only while the upstream total and unique rows agree. */
export function createBseSource({
  endpoint,
  client,
  attachmentBase,
  maxPages,
  logger,
}) {
  return async ({ from, to, company, signal }) => {
    const records = new Map();
    let expectedTotal;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const requestUrl = new URL(endpoint);
      for (const [name, value] of Object.entries({
        pageno: pageNumber,
        strType: "C",
        strSearch: "P",
        strScrip: company?.bseScripCode ?? "",
        strPrevDate: queryDate(from, "bse"),
        strToDate: queryDate(to, "bse"),
        strCat: "-1",
        subcategory: "-1",
      }))
        requestUrl.searchParams.set(name, value);
      const payload = read(
        pageSchema,
        await client.json(requestUrl, { signal }),
      );
      const total = totals.safeParse(payload.Table1);
      if ((payload.Table1 !== undefined || pageNumber === 1) && !total.success)
        return incomplete(pageNumber, "bse_invalid_total");
      const count = total.success ? total.data[0].ROWCNT : expectedTotal;
      expectedTotal ??= count;
      if (
        expectedTotal !== count ||
        (!payload.Table.length && records.size < count)
      )
        return incomplete(pageNumber, "bse_inconsistent_total");
      for (const row of payload.Table) {
        const filing = normalizeBse(row, {
          company,
          requestUrl,
          attachmentBase,
          logger,
        });
        if (records.has(filing.sourceFilingId))
          return incomplete(pageNumber, "bse_duplicate_page_row");
        records.set(filing.sourceFilingId, filing);
      }
      if (records.size > count)
        return incomplete(pageNumber, "bse_exceeds_total");
      if (records.size === count)
        return {
          records: [...records.values()],
          complete: true,
          fetchedPages: pageNumber,
          diagnostics: { expectedTotal },
        };
    }
    return incomplete(maxPages, "bse_page_cap");
  };
}
