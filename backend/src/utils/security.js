import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { PipelineError } from "./errors.js";

/** Parse a public HTTPS hostname URL before applying a source-specific allowlist. */
export function parseSourceUrl(value) {
  const unsafe = () => new PipelineError("DOWNLOAD_UNSAFE_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw unsafe();
  }
  const host = url.hostname;
  // Reject literal addresses entirely, including alternate IPv4 forms normalized by URL.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    host.startsWith("[") ||
    isIP(host) ||
    !host.includes(".") ||
    host.endsWith(".") ||
    /\.(localhost|local|internal|lan|home\.arpa)$/u.test(host)
  ) {
    throw unsafe();
  }
  return url;
}

/** Require an exact trusted hostname, including on each redirect. */
export function validateSourceUrl(value, allowedHosts, { redirectFrom } = {}) {
  let target = value;
  if (redirectFrom !== undefined) {
    const previous = validateSourceUrl(redirectFrom, allowedHosts);
    try {
      target = new URL(value, previous);
    } catch {
      throw new PipelineError("DOWNLOAD_UNSAFE_URL");
    }
  }
  const url = parseSourceUrl(target);
  if (!allowedHosts.includes(url.hostname))
    throw new PipelineError("DOWNLOAD_UNSAFE_URL");
  return url;
}

/**
 * Resolve an approved URL and reject any non-public DNS result.
 * An HTTP caller must pin its connection to one returned address and repeat this for redirects.
 */
export async function resolveSourceUrl(
  value,
  allowedHosts,
  { redirectFrom, resolve = lookup } = {},
) {
  const url = validateSourceUrl(value, allowedHosts, { redirectFrom });
  let addresses;
  try {
    addresses = await resolve(url.hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new PipelineError("SOURCE_UNAVAILABLE", undefined, {
      cause,
      retryable: true,
    });
  }
  // ipaddr.process also handles IPv4-mapped IPv6 addresses.
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !ipaddr.isValid(address) ||
        ipaddr.process(address).range() !== "unicast",
    )
  ) {
    throw new PipelineError("DOWNLOAD_UNSAFE_URL");
  }
  return { url, addresses };
}
