import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

/** Keep synthetic transport data on reserved domains and inject DNS and response streams. */
export function response(body, status = 200, headers = {}) {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const stream = Readable.from([bytes]);
  stream.statusCode = status;
  stream.headers = {
    "content-type": Buffer.isBuffer(body)
      ? "application/pdf"
      : "application/json",
    ...headers,
  };
  return stream;
}

export const fakeAddresses = async () => [
  { address: "93.184.216.34", family: 4 },
];
export const fixtureJson = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/exchange/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
export const pdfBytes = (name) =>
  readFileSync(
    new URL(`../../fixtures/pdf/synthetic-${name}.pdf`, import.meta.url),
  );
