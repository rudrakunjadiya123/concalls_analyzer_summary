import { dateSchema, utcInstantSchema } from "@finosauras/shared";

export const systemClock = Object.freeze({ now: () => new Date() });
export const EXCHANGE_TIME_ZONE = "Asia/Kolkata";
const indianDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: EXCHANGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Format a valid instant as a UTC ISO timestamp suitable for storage. */
export function utcIso(instant = systemClock.now()) {
  return utcInstantSchema.parse(instant.toISOString());
}

/** Return the exchange calendar date for the given instant. */
export function istDate(instant) {
  const parts = Object.fromEntries(
    indianDate.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return dateSchema.parse(`${parts.year}-${parts.month}-${parts.day}`);
}

/** Convert an ISO-shaped modern exchange-local datetime to UTC. */
export function istLocalToUtc(localTime) {
  // Modern NSE/BSE feeds use UTC+05:30. Offset-bearing data should be parsed as an instant.
  utcInstantSchema.parse(`${localTime}Z`);
  return utcIso(new Date(`${localTime}+05:30`));
}
