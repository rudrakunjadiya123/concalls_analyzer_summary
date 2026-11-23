import { randomUUID } from "node:crypto";
import { companyIdentitySchema } from "@finosauras/shared";
import { systemClock, utcIso } from "../core/clock.js";

// These are candidate mappings from the specification; ISIN and verification time stay null.
const watchlist = [
  ["INFY", "500209", "Infosys Limited", "IT"],
  ["TCS", "532540", "Tata Consultancy Services Limited", "IT"],
  ["HDFCBANK", "500180", "HDFC Bank Limited", "Banking"],
  ["ICICIBANK", "532174", "ICICI Bank Limited", "Banking"],
  ["SUNPHARMA", "524715", "Sun Pharmaceutical Industries Limited", "Pharma"],
  ["DRREDDY", "500124", "Dr. Reddy's Laboratories Limited", "Pharma"],
  ["MARUTI", "532500", "Maruti Suzuki India Limited", "Auto"],
  ["LT", "500510", "Larsen & Toubro Limited", "Industrial"],
];

/** Insert initial companies once. Existing verified identities and edits are preserved. */
export function seedWatchlist(
  db,
  { clock = systemClock, makeId = randomUUID } = {},
) {
  const insert = db.prepare(`INSERT INTO companies
    (id, display_name, sector, nse_symbol, bse_scrip_code, active, created_at, updated_at)
    VALUES (@id, @displayName, @sector, @nseSymbol, @bseScripCode, 1, @now, @now)
    ON CONFLICT (nse_symbol) DO NOTHING`);
  return db
    .transaction(() => {
      const now = utcIso(clock.now());
      let inserted = 0;
      for (const [nseSymbol, bseScripCode, displayName, sector] of watchlist) {
        const company = companyIdentitySchema.parse({
          nseSymbol,
          bseScripCode,
          displayName,
          isin: null,
        });
        inserted += insert.run({
          ...company,
          sector,
          id: makeId(),
          now,
        }).changes;
      }
      return {
        inserted,
        total: db.prepare("SELECT count(*) AS total FROM companies").get()
          .total,
      };
    })
    .immediate();
}
