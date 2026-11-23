import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readConfig } from "../../../backend/src/config/env.js";
import { openDatabase } from "../../../backend/src/config/database.js";
import { requestReplay } from "../../../backend/src/services/ingestion/replay.js";
import { startApi } from "../../../backend/src/index.js";

test("a fixture push changes the watchlist, a disconnected browser replays its correction, and both revisions open", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "fin-e2e-"));
  const config = {
    ...readConfig({ DATA_DIR: root, HOST: "127.0.0.1", LOG_LEVEL: "silent" }),
    PORT: 0,
  };
  let api;
  try {
    api = await startApi(config);
    const base = `http://127.0.0.1:${api.server.address().port}`;
    let blocked = false,
      active;
    await page.routeWebSocket("**/ws/summaries", (route) => {
      if (blocked)
        route.close({ code: 1001, reason: "Simulated connection loss" });
      else {
        active = route;
        route.connectToServer();
      }
    });
    function queue(variant) {
      const db = openDatabase(config);
      try {
        expect(requestReplay(db, config, variant).queued).toBe(true);
      } finally {
        db.close();
      }
    }
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await expect(
      page.getByRole("heading", { name: "Company watchlist" }),
    ).toBeVisible();
    await expect(
      page.getByText("Synthetic demo", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Summary updates connected")).toBeVisible();
    await expect(
      page.getByText("Exchange polling is off in demo mode.", { exact: false }),
    ).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(8);
    await expect(
      page.getByRole("heading", { name: "Source health" }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search" })
      .fill("no-such-company");
    await expect(
      page.getByText("No companies match these filters."),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search" }).fill("TCS");
    await expect(page.locator("tbody tr")).toHaveCount(1);

    // Let automatic bootstrap finish before triggering a distinct event with the browser connected.
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${base}/api/events/latest`)).json())
            .data.last_event_id,
      )
      .toBe(1);
    queue("replay");
    let original;
    await expect
      .poll(async () => {
        const events = (
          await (await page.request.get(`${base}/api/events?after_id=1`)).json()
        ).data;
        original = events[0]
          ? `/summaries/${events[0].data.summary_id}`
          : undefined;
        return events[0]?.type;
      })
      .toBe("summary.created");
    const pushed = page.getByRole("status").filter({ hasText: "New summary" });
    await expect(pushed.getByRole("link")).toHaveAttribute("href", original);
    await expect(
      page.locator("tbody tr").getByRole("link", { name: "Q3 FY27" }),
    ).toHaveAttribute("href", original);

    blocked = true;
    active.close({ code: 1001, reason: "Simulated connection loss" });
    await expect(
      page.getByText("Summary updates disconnected.", { exact: false }).first(),
    ).toBeVisible();
    queue("correction");
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`${base}/api/events?after_id=2`)
            ).json()
          ).data[0]?.type,
      )
      .toBe("summary.updated");
    const catchup = page.waitForResponse(
      (response) =>
        response.url().includes("/api/events?after_id=2") && response.ok(),
    );
    blocked = false;
    await catchup;
    await expect(page.getByText("Summary updates connected")).toBeVisible();
    const updated = page
      .getByRole("status")
      .filter({ hasText: "Updated summary" });
    await expect(updated).toBeVisible();
    const correction = await updated.getByRole("link").getAttribute("href");
    expect(correction).not.toBe(original);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.locator("tbody tr th a").click();
    await expect(
      page.getByRole("heading", { name: "Call summaries" }),
    ).toBeVisible();
    await expect(page.getByText("Current · v2", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Superseded · v1", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(`a[href="${correction}"]`)).toHaveCount(1);
    await page.locator(`a[href="${correction}"]`).click();
    for (const name of [
      "Key takeaways",
      "Key metrics",
      "Management commentary",
      "Guidance",
      "Segment performance",
      "Notable Q&A",
      "Risks",
    ]) {
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
    }
    await page.locator("details summary").first().click();
    await expect(
      page.locator("details[open] blockquote").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "View JSON" }).click();
    await expect(page.getByLabel("Summary JSON")).toContainText(
      '"source": "FIXTURE"',
    );
    await page.getByRole("button", { name: "View Markdown" }).click();
    await expect(page.getByLabel("Summary Markdown")).toContainText(
      "Synthetic",
    );
    await page.goto(`${base}${original}`);
    await expect(
      page.getByText("Superseded · v1", { exact: true }),
    ).toBeVisible();
    await page.route(
      `**/api${original}`,
      async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        // Model/storage validation normally blocks this. The UI still renders untrusted text inertly.
        const script = '<img src=x onerror="document.body.dataset.unsafe = 1">';
        payload.data.json.tldr[0] = script;
        payload.data.json.guidance = [];
        payload.data.json.call_date = null;
        payload.data.markdown = script;
        // Summary pages keep evidence available while omitting validation and coverage panels.
        payload.data.validation.warnings = [
          "conflicting_metrics_retained_with_context",
          "omitted_key_metrics",
        ];
        payload.data.sources = [
          {
            source: "NSE",
            source_url: "javascript:document.body.dataset.unsafe=1",
          },
        ];
        await route.fulfill({ response, json: payload });
      },
      { times: 1 },
    );
    await page.reload();
    await expect(
      page.getByText("No explicit management guidance was verified."),
    ).toBeVisible();
    await expect(
      page.getByText("Original filing link unverified", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Validation warnings", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Source and coverage notes", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "View Markdown" }).click();
    await expect(page.getByLabel("Summary Markdown")).toContainText(
      "<img src=x",
    );
    expect(await page.locator("body").getAttribute("data-unsafe")).toBeNull();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => globalThis.document.activeElement?.tagName),
    ).toMatch(/BUTTON|DETAILS|SUMMARY|A/);
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(base);
    await expect(
      page.getByRole("heading", { name: "Company watchlist" }),
    ).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(8);
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth,
      ),
    ).toBeLessThanOrEqual(375);
    expect(errors).toEqual([]);
  } finally {
    await api?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the real-data watchlist explains disabled polling and retries a failed initial request", async ({
  page,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "fin-e2e-empty-"));
  let api;
  try {
    api = await startApi({
      ...readConfig({
        DATA_DIR: root,
        HOST: "127.0.0.1",
        LOG_LEVEL: "silent",
        DATA_MODE: "authorized-direct",
        GEMINI_API_KEY: "synthetic-test-key",
      }),
      PORT: 0,
    });
    await page.route(
      "**/api/watchlist",
      async (route) => {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "DATABASE_BUSY",
              message: "Service temporarily unavailable",
            },
          },
        });
      },
      { times: 1 },
    );
    await page.routeWebSocket("**/ws/summaries", (route) =>
      route.close({ code: 1001, reason: "Fixture connection unavailable" }),
    );
    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.data.sources.NSE = {
        ...payload.data.sources.NSE,
        status: "blocked",
        reason: "SOURCE_FORBIDDEN",
      };
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`http://127.0.0.1:${api.server.address().port}`);
    await expect(
      page.getByText("Live exchange polling is off.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "Service temporarily unavailable",
    );
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(8);
    await expect(
      page.getByText("source forbidden", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Summary updates disconnected.", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Summary updates connected", { exact: true }),
    ).toHaveCount(0);
    await page.locator("tbody tr th a").first().click();
    await expect(
      page.getByText("No transcript yet.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Identity unverified")).toBeVisible();
  } finally {
    await api?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
