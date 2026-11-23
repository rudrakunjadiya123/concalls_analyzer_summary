import { z } from "zod";
import { normalizedFilingSchema } from "@finosauras/shared";
import { parseNormalizedFiling } from "../domain/filing.js";
import { incomplete, read, safePublicLink } from "./normalize.js";

const pageSchema = z.strictObject({
  records: z.array(
    normalizedFilingSchema.refine(
      (row) =>
        row.source === "LICENSED" &&
        Boolean(row.originatingExchange) &&
        Boolean(safePublicLink(row.sourceUrl)),
    ),
  ),
  nextCursor: z.string().min(1).max(4096).nullable(),
});

/** Discover the documented licensed JSON gateway contract. */
export function createLicensedSource({ endpoint, client, maxPages, token }) {
  return async ({ from, to, company, signal }) => {
    const records = new Map();
    const seen = new Set();
    let cursor = null;
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(endpoint);
      url.searchParams.set("from", from.toISOString());
      url.searchParams.set("to", to.toISOString());
      // Clear company filters from the configured URL for a market-wide request.
      for (const field of ["nseSymbol", "bseScripCode", "isin", "cursor"])
        url.searchParams.delete(field);
      for (const field of ["nseSymbol", "bseScripCode", "isin"]) {
        if (company?.[field]) url.searchParams.set(field, company[field]);
      }
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = read(pageSchema, await client.json(url, { signal, token }));
      for (const item of data.records) {
        const record = parseNormalizedFiling(item, company);
        if (records.has(record.sourceFilingId))
          return incomplete(page, "licensed_duplicate_row");
        records.set(record.sourceFilingId, record);
      }
      if (data.nextCursor === null)
        return {
          records: [...records.values()],
          complete: true,
          fetchedPages: page,
          diagnostics: {},
        };
      if (!data.records.length || seen.has(data.nextCursor))
        return incomplete(page, "licensed_invalid_cursor");
      seen.add(data.nextCursor);
      cursor = data.nextCursor;
    }
    return incomplete(maxPages, "licensed_page_cap");
  };
}
