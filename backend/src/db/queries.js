/** Probe the persistent connection, migration ledger and seeded watchlist. */
export function isDatabaseReady(db, expectedVersion) {
  // A write-free query keeps liveness separate from local storage readiness.
  const { version, companyCount } = db
    .prepare(
      `
    SELECT (SELECT max(version) FROM schema_migrations) AS version,
           (SELECT count(*) FROM companies) AS companyCount
  `,
    )
    .get();
  return version === expectedVersion && companyCount > 0;
}

/** Validate JSON data against the column's domain schema before writing. */
export function encodeJson(schema, value) {
  return JSON.stringify(schema.parse(value));
}

/** Parse stored JSON, then validate it again at the database read boundary. */
export function decodeJson(schema, value) {
  return schema.parse(JSON.parse(value));
}
