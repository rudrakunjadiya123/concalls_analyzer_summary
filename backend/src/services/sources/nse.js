import { z } from "zod";
import {
  attachment,
  clean,
  normalized,
  optionalId,
  optionalText,
  publicationTime,
  queryDate,
  read,
  safePublicLink,
  xbrlAttachment,
} from "./normalize.js";

const nseResponse = z.array(
  z
    .looseObject({
      seq_id: optionalId,
      seqId: optionalId,
      symbol: z.string(),
      sm_name: optionalText,
      companyName: optionalText,
      sm_isin: optionalText,
      isin: optionalText,
      desc: optionalText,
      subject: optionalText,
      attchmntText: optionalText,
      attchmntFile: optionalText,
      attachmentUrl: optionalText,
      an_dt: optionalText,
      exchdisstime: optionalText,
      category: optionalText,
      subcategory: optionalText,
      sourceUrl: optionalText,
    })
    .refine((row) => Boolean(clean(row.desc) || clean(row.subject))),
);

/** Normalize the tested NSE array contract while retaining the original raw row. */
export function normalizeNse(payload, { company, requestUrl, logger }) {
  return read(nseResponse, payload).map((row) => {
    const file = attachment(
      clean(row.attchmntFile) ?? clean(row.attachmentUrl),
    );
    return normalized(
      "NSE",
      {
        sourceFilingId: row.seq_id ?? row.seqId,
        company: {
          displayName:
            clean(row.sm_name) ??
            clean(row.companyName) ??
            company?.displayName ??
            row.symbol.trim(),
          nseSymbol: row.symbol.trim(),
          bseScripCode: null,
          isin: clean(row.sm_isin) ?? clean(row.isin),
        },
        subject: clean(row.desc) ?? clean(row.subject),
        description: row.attchmntText ?? "",
        category: clean(row.category),
        subcategory: clean(row.subcategory),
        publishedAt: publicationTime(
          clean(row.an_dt) ?? clean(row.exchdisstime),
        ),
        sourceUrl:
          safePublicLink(row.sourceUrl) ??
          file?.url ??
          `${requestUrl.origin}${requestUrl.pathname}`,
        attachments: [file, xbrlAttachment(row.xbrlUrl ?? row.xbrl)].filter(
          Boolean,
        ),
        raw: row,
      },
      company,
      logger,
    );
  });
}

/** Create the authorized NSE adapter for the tested, single-array feed shape. */
export function createNseSource({ endpoint, client, logger }) {
  return async ({ from, to, company, signal }) => {
    const requestUrl = new URL(endpoint);
    for (const [name, value] of Object.entries({
      index: "equities",
      from_date: queryDate(from, "nse"),
      to_date: queryDate(to, "nse"),
    }))
      requestUrl.searchParams.set(name, value);
    // The market scan uses the feed's unfiltered date window.
    requestUrl.searchParams.delete("symbol");
    if (company) requestUrl.searchParams.set("symbol", company.nseSymbol);
    const payload = await client.json(requestUrl, { signal });
    return {
      records: normalizeNse(payload, { company, requestUrl, logger }),
      complete: true,
      fetchedPages: 1,
      diagnostics: {},
    };
  };
}
