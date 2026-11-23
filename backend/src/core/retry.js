import { setTimeout as sleepTimer } from "node:timers/promises";
import { PipelineError } from "./errors.js";
import { systemClock } from "./clock.js";

/** Interpret Retry-After seconds or an RFC HTTP date relative to an injected clock. */
export function retryAfterMs(header, now = systemClock.now()) {
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (/^\d+$/u.test(value)) return Number(value) * 1000;
  if (
    !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      value,
    )
  )
    return null;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value
    ? Math.max(0, date - now.getTime())
    : null;
}

/** Retry opted-in failures with bounded full jitter and Retry-After precedence. */
export async function withRetry(
  operation,
  {
    maxAttempts = 4,
    baseDelayMs = 3000,
    maxDelayMs = 300_000,
    clock = systemClock,
    random = Math.random,
    signal,
    deadline,
    sleep = (ms, abort) => sleepTimer(ms, undefined, { signal: abort }),
    getRetryAfter = () => null,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    ![baseDelayMs, maxDelayMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new RangeError("Invalid retry budget");
  }
  const permanent = [
    "SOURCE_NOT_AUTHORIZED",
    "SOURCE_FORBIDDEN",
    "DOWNLOAD_UNSAFE_URL",
  ];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      if (
        !(error instanceof PipelineError) ||
        !error.retryable ||
        permanent.includes(error.code) ||
        [401, 403].includes(error.statusCode) ||
        attempt === maxAttempts
      )
        throw error;
      signal?.throwIfAborted();
      const now = clock.now();
      const requested = retryAfterMs(getRetryAfter(error), now);
      const jitter = Math.floor(
        random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)),
      );
      // Let the caller schedule a longer pause instead of retrying before an upstream deadline.
      if (requested > maxDelayMs) throw error;
      const wait = requested ?? jitter;
      if (deadline && now.getTime() + wait >= deadline.getTime()) throw error;
      await sleep(wait, signal);
    }
  }
}
