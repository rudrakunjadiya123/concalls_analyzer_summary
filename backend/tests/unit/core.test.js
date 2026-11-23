import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { istDate, istLocalToUtc } from "../../src/utils/clock.js";
import { PipelineError, publicError } from "../../src/utils/errors.js";
import { documentStorageKey, sha256 } from "../../src/utils/hash.js";
import { createLogger } from "../../src/utils/logger.js";
import { retryAfterMs, withRetry } from "../../src/utils/retry.js";
import {
  resolveSourceUrl,
  validateSourceUrl,
} from "../../src/utils/security.js";
import { safePath } from "../../src/utils/storage.js";

const instant = new Date("2026-11-22T18:30:00.000Z");
const clock = { now: () => instant };
const origin = "https://feed.example.com/updates";
const hosts = ["feed.example.com"];

describe("clock and storage keys", () => {
  it("converts IST midnight across the UTC date boundary", () => {
    expect(istDate(new Date(instant.getTime() - 1))).toBe("2026-11-22");
    expect(istDate(instant)).toBe("2026-11-23");
    expect(istLocalToUtc("2026-11-23T00:00:00")).toBe(instant.toISOString());
    expect(() => istLocalToUtc("2026-02-30T00:00:00")).toThrow();
  });

  it("uses exact content hashes and private content-addressed file names", () => {
    const digest =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256(Buffer.from("abc"))).toBe(digest);
    expect(documentStorageKey(digest)).toBe(`documents/ba/${digest}.pdf`);
    expect(() => documentStorageKey("../fake")).toThrow();
  });

  it("rejects traversal and unsafe portable file names", () => {
    const root = path.resolve("test-data");
    expect(safePath(root, "documents/ab/file.pdf")).toBe(
      path.join(root, "documents", "ab", "file.pdf"),
    );
    for (const bad of [
      "../secret",
      "a\\..\\secret",
      "/etc/passwd",
      "C:\\file",
      "db:stream",
      "NUL.txt",
      "nested/.. /private",
      "a\u0000b",
    ]) {
      expect(() => safePath(root, bad)).toThrow(
        expect.objectContaining({ code: "UNSAFE_PATH" }),
      );
    }
  });
});

describe("URL validation", () => {
  it("requires an exact allowed host and revalidates redirect destinations", () => {
    expect(
      validateSourceUrl("/attachment", hosts, { redirectFrom: origin }).href,
    ).toBe("https://feed.example.com/attachment");
    for (const bad of [
      "file:///tmp/file",
      "http://feed.example.com",
      "https://feed.example.com.evil.invalid",
      "https://evil.invalid/?url=https://feed.example.com",
      "https://u:p@feed.example.com",
      "https://feed.example.com:4433",
      "//169.254.169.254/metadata",
      "https://127.0.0.1",
      "https://2130706433",
      "https://[::1]",
      "https://localhost",
      "https://100.64.0.1",
    ]) {
      expect(() =>
        validateSourceUrl(bad, hosts, { redirectFrom: origin }),
      ).toThrow(expect.objectContaining({ code: "DOWNLOAD_UNSAFE_URL" }));
    }
  });

  it("rejects redirects to allowed hostnames resolving to private or mixed addresses", async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:192.168.1.20", family: 6 },
    ]);
    await expect(
      resolveSourceUrl("/attachment", hosts, { redirectFrom: origin, resolve }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_UNSAFE_URL" });
    expect(resolve).toHaveBeenCalledOnce();
    resolve.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      resolveSourceUrl(origin, hosts, { resolve }),
    ).resolves.toMatchObject({
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });
});

describe("error, log and retry policy", () => {
  it("returns safe public codes and drops secrets in log metadata", () => {
    const write = vi.fn();
    const logger = createLogger({ clock, write });
    const error = new PipelineError("SOURCE_UNAVAILABLE", "synthetic-secret", {
      cause: new Error("path"),
      retryable: true,
    });
    logger.warn("request_failed", {
      stage: "source",
      source: "NSE",
      error_code: error.code,
      error,
      token: "synthetic-secret",
    });
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({
      timestamp: instant.toISOString(),
      level: "warn",
      event: "request_failed",
      stage: "source",
      source: "NSE",
      error_code: "SOURCE_UNAVAILABLE",
    });
    expect(publicError(error)).toEqual({
      error: { code: "SOURCE_UNAVAILABLE", message: "Source is unavailable" },
    });
    expect(publicError(new Error("secret"))).toMatchObject({
      error: { code: "UNEXPECTED_ERROR" },
    });
  });

  it("uses retry-after seconds and dates, then injected full jitter", async () => {
    const sleep = vi.fn();
    const retryable = new PipelineError("SOURCE_RATE_LIMITED", undefined, {
      retryable: true,
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue("ok");
    const header = vi.fn().mockReturnValueOnce("7").mockReturnValueOnce(null);
    expect(
      retryAfterMs(new Date(instant.getTime() + 9000).toUTCString(), instant),
    ).toBe(9000);
    expect(retryAfterMs("invalid", instant)).toBeNull();
    await expect(
      withRetry(operation, {
        clock,
        sleep,
        random: () => 0.5,
        getRetryAfter: header,
      }),
    ).resolves.toBe("ok");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7000, 3000]);
  });

  it("never retries forbidden requests, attempts beyond the cap, or a delay outside the deadline", async () => {
    const forbidden = new PipelineError("SOURCE_FORBIDDEN", undefined, {
      retryable: true,
    });
    const unavailable = new PipelineError("SOURCE_UNAVAILABLE", undefined, {
      retryable: true,
    });
    const sleep = vi.fn();
    const operation = vi.fn().mockRejectedValue(forbidden);
    await expect(withRetry(operation, { sleep })).rejects.toBe(forbidden);
    expect(operation).toHaveBeenCalledOnce();
    operation.mockClear().mockRejectedValue(unavailable);
    await expect(withRetry(operation, { sleep, maxAttempts: 2 })).rejects.toBe(
      unavailable,
    );
    expect(operation).toHaveBeenCalledTimes(2);
    operation.mockClear();
    await expect(
      withRetry(operation, {
        clock,
        sleep,
        deadline: new Date(instant.getTime() + 1000),
        getRetryAfter: () => "10",
      }),
    ).rejects.toBe(unavailable);
    expect(operation).toHaveBeenCalledOnce();
  });
});
