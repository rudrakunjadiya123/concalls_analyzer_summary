import {
  companyIdentitySchema,
  normalizedFilingSchema,
} from "@finosauras/shared";
import { PipelineError } from "../core/errors.js";

/** Validate a filing and compare its identifiers with the expected watchlist company if provided. */
export function parseNormalizedFiling(value, expectedCompany) {
  const result = normalizedFilingSchema.safeParse(value);
  if (!result.success)
    throw new PipelineError("SOURCE_SCHEMA_CHANGED", undefined, {
      stage: "source",
    });
  const filing = result.data;
  if (expectedCompany === undefined) return filing;

  const expected = companyIdentitySchema.parse(expectedCompany);
  let match = false;
  for (const field of ["nseSymbol", "bseScripCode", "isin"]) {
    const actual = filing.company[field];
    if (!expected[field] || !actual) continue;
    if (expected[field] !== actual) {
      throw new PipelineError("COMPANY_IDENTITY_CONFLICT", undefined, {
        stage: "source",
        source: filing.source,
      });
    }
    match = true;
  }
  // Similar names alone cannot establish identity across exchanges.
  if (!match)
    throw new PipelineError("UNVERIFIED_COMPANY", undefined, {
      stage: "source",
      source: filing.source,
    });
  return filing;
}
