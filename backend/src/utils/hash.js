import { createHash } from "node:crypto";

/** Return the SHA-256 hex digest of the exact supplied bytes (or UTF-8 string). */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Return the private, content-addressed storage key for validated PDF bytes. */
export function documentStorageKey(digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new TypeError("Expected a SHA-256 hex digest");
  return `documents/${digest.slice(0, 2)}/${digest}.pdf`;
}
