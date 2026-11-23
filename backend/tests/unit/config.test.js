import path from "node:path";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { readConfig, sourceGrants } from "../../src/config/env.js";
import { publicError } from "../../src/utils/errors.js";

describe("environment configuration", () => {
  it("uses all documented defaults and disables external source access", () => {
    const example = parseEnv(
      readFileSync(new URL("../../.env.example", import.meta.url), "utf8"),
    );
    const defaults = readConfig({});
    // The example must stay complete and behave just like a blank environment.
    expect(Object.keys(example).sort()).toEqual(Object.keys(defaults).sort());
    expect(readConfig(example)).toEqual(defaults);
    expect(defaults.DATABASE_PATH).toBe(path.resolve("data", "app.sqlite"));
    expect(defaults).toMatchObject({
      DATA_MODE: "fixture",
      AI_PROVIDER: "mock",
      GEMINI_API_KEY: "",
      POLL_INTERVAL_SECONDS: 300,
      PORT: 3000,
    });
    expect(sourceGrants(defaults)).toEqual({
      FIXTURE: true,
      NSE: false,
      BSE: false,
      LICENSED: false,
    });
  });

  it.each([
    ["DATA_MODE", "live"],
    ["AI_PROVIDER", "extractive"],
    ["POLL_INTERVAL_SECONDS", "5.5"],
    ["POLL_INTERVAL_SECONDS", "0"],
    ["MAX_DOWNLOAD_BYTES", "-1"],
    ["LIVE_POLLING_ENABLED", "yes"],
    ["PORT", "65536"],
    ["NSE_FEED_URL", "file:///tmp/filings.json"],
    ["BSE_FEED_URL", "http://feed.example.com"],
    ["DATABASE_PATH", "../outside.sqlite"],
    ["AI_CHUNK_OVERLAP_TOKENS", "6000"],
  ])("rejects invalid %s", (field, value) => {
    expect(() => readConfig({ [field]: value })).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        fields: [field],
      }),
    );
  });

  it("requires matching authorization and URL for each enabled direct source", () => {
    const direct = {
      DATA_MODE: "authorized-direct",
      LIVE_POLLING_ENABLED: "true",
      GEMINI_API_KEY: "synthetic-test-key",
    };
    expect(() => readConfig(direct)).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() =>
      readConfig({ ...direct, NSE_FEED_URL: "https://feed.example.com" }),
    ).toThrow();
    expect(
      sourceGrants(
        readConfig({
          ...direct,
          NSE_FEED_URL: "https://feed.example.com",
          NSE_ACCESS_AUTHORIZED: "true",
        }),
      ),
    ).toEqual({ FIXTURE: false, NSE: true, BSE: false, LICENSED: false });
    expect(
      sourceGrants(
        readConfig({
          NSE_FEED_URL: "https://feed.example.com",
          NSE_ACCESS_AUTHORIZED: "true",
          LIVE_POLLING_ENABLED: "true",
        }),
      ).NSE,
    ).toBe(false);
  });

  it("requires licensed access and provider credentials when applicable", () => {
    const licensed = {
      DATA_MODE: "licensed-feed",
      LIVE_POLLING_ENABLED: "true",
      GEMINI_API_KEY: "synthetic-test-key",
      LICENSED_FEED_URL: "https://feed.example.com",
      LICENSED_FEED_REQUIRES_TOKEN: "true",
    };
    expect(() => readConfig(licensed)).toThrow(
      expect.objectContaining({
        fields: ["LICENSED_FEED_AUTHORIZED", "LICENSED_FEED_TOKEN"],
      }),
    );
    expect(
      sourceGrants(
        readConfig({
          ...licensed,
          LICENSED_FEED_AUTHORIZED: "true",
          LICENSED_FEED_TOKEN: "synthetic-test-token",
        }),
      ).LICENSED,
    ).toBe(true);
  });

  it("boots the default profile with blank Gemini settings", () => {
    expect(
      readConfig({ GEMINI_MODEL: "", GEMINI_API_KEY: "" }).GEMINI_MODEL,
    ).toBe("gemini-3.5-flash-lite");
  });

  it("reports a missing Gemini key and hides rejected config values", () => {
    expect(() => readConfig({ DATA_MODE: "authorized-direct" })).toThrow(
      expect.objectContaining({
        fields: ["GEMINI_API_KEY"],
      }),
    );
    try {
      readConfig({
        NSE_FEED_URL: "https://user:synthetic-secret@feed.example.com",
      });
      throw new Error("Expected invalid configuration");
    } catch (error) {
      expect(publicError(error)).toEqual({
        error: {
          code: "CONFIG_INVALID",
          message: "Invalid application configuration",
        },
      });
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    }
  });

  it("requires Gemini for real data and limits the mock to fixtures", () => {
    const live = {
      DATA_MODE: "authorized-direct",
      GEMINI_API_KEY: "synthetic-test-key",
    };
    expect(readConfig(live).AI_PROVIDER).toBe("gemini");
    expect(() => readConfig({ ...live, AI_PROVIDER: "mock" })).toThrow(
      expect.objectContaining({ fields: ["AI_PROVIDER"] }),
    );
    expect(() =>
      readConfig({
        AI_PROVIDER: "gemini",
        GEMINI_API_KEY: "synthetic-test-key",
      }),
    ).toThrow(expect.objectContaining({ fields: ["AI_PROVIDER"] }));
  });
});
