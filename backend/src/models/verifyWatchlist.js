import { utcInstantSchema } from "@finosauras/shared";
import { systemClock, utcIso } from "../utils/clock.js";
import { PipelineError } from "../utils/errors.js";

// Source documents and the review date are recorded in docs/SOURCE_VERIFICATION.md.
const reviewedAt = "2026-11-23T04:05:00.000Z";
const reviewedIdentities = [
  ["INFY", "500209", "INE009A01021"],
  ["TCS", "532540", "INE467B01029"],
  ["HDFCBANK", "500180", "INE040A01034"],
  ["ICICIBANK", "532174", "INE090A01021"],
  ["SUNPHARMA", "524715", "INE044A01036"],
  ["DRREDDY", "500124", "INE089A01031"],
  ["MARUTI", "532500", "INE585B01010"],
  ["LT", "500510", "INE018A01030"],
];

/** Apply reviewed identifiers without replacing existing company records or history. */
export function verifyWatchlist(db, { clock = systemClock } = {}) {
  const company = db.prepare(
    "SELECT id, bse_scrip_code, isin, identity_verified_at FROM companies WHERE nse_symbol = ?",
  );
  const ownerOfIsin = db.prepare("SELECT id FROM companies WHERE isin = ?");
  const update = db.prepare(
    "UPDATE companies SET isin = ?, identity_verified_at = ?, updated_at = ? WHERE id = ?",
  );
  return db
    .transaction(() => {
      let updated = 0;
      const now = utcIso(clock.now());
      for (const [symbol, bseCode, isin] of reviewedIdentities) {
        const row = company.get(symbol);
        if (!row) throw new PipelineError("UNVERIFIED_COMPANY");
        const owner = ownerOfIsin.get(isin);
        if (
          row.bse_scrip_code !== bseCode ||
          (row.isin && row.isin !== isin) ||
          (owner && owner.id !== row.id)
        )
          throw new PipelineError("COMPANY_IDENTITY_CONFLICT");
        if (
          row.isin === isin &&
          utcInstantSchema.safeParse(row.identity_verified_at).success
        )
          continue;
        updated += update.run(isin, reviewedAt, now, row.id).changes;
      }
      return {
        verified: reviewedIdentities.length,
        updated,
        reviewed_at: reviewedAt,
      };
    })
    .immediate();
}
