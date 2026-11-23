import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { summaryEventSchema } from "@finosauras/shared";

const project = `finosauras-smoke-${randomUUID().slice(0, 8)}`;
// Exclude the operator's local .env so the smoke can call only bundled sources.
const dockerEnv = {
  ...process.env,
  APP_PORT: process.env.FINOSAURAS_SMOKE_PORT ?? "0",
  APP_ENV_FILE: `.${project}.env`,
  COMPOSE_DISABLE_ENV_FILE: "1",
};
let browser, socket;

function compose(args, { capture = false } = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "--file", "compose.yaml", "--project-name", project, ...args],
    {
      env: dockerEnv,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      timeout: 240_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Compose failed: ${args.join(" ")}`);
  return result.stdout?.trim();
}

// Use an isolated Compose project and an OS-assigned loopback port by default.
try {
  compose(["config", "--quiet"]);
  compose(["up", "--build", "-d", "--wait"]);
  const host = compose(["port", "app", "3000"], { capture: true });
  const origin = `http://${host}`;
  async function get(route) {
    const response = await fetch(`${origin}/api${route}`, {
      signal: AbortSignal.timeout(5000),
      // Restart testing can reuse the same host port. Avoid pooling sockets across containers.
      headers: { Connection: "close" },
    });
    assert.equal(response.status, 200, route);
    return (await response.json()).data;
  }
  async function until(check) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await check();
      if (value) return value;
      await sleep(200);
    }
    throw new Error("Timed out waiting for fixture publication");
  }
  const baseline = await until(async () => (await get("/events"))[0]);
  const status = await get("/status");
  assert.equal(status.data_mode, "fixture");
  assert.equal(status.ai_processing.is_mock, true);
  assert.equal(status.scheduler_running, true);
  assert.equal((await get("/watchlist")).length, 8);
  assert.equal(baseline.data.summary.source, "FIXTURE");

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByText("Synthetic demo", { exact: true }).waitFor();
  await page.getByText("Summary updates connected", { exact: true }).waitFor();
  socket = new WebSocket(`ws://${host}/ws/summaries`);
  const received = [];
  socket.addEventListener("message", ({ data }) =>
    received.push(JSON.parse(data)),
  );
  const hello = await until(() => received[0]);
  assert.deepEqual(hello, {
    schema_version: 1,
    type: "connected",
    data: { last_event_id: baseline.event_id, data_mode: "fixture" },
  });
  const createStart = performance.now();
  compose(["exec", "-T", "app", "npm", "run", "demo:replay"]);
  const created = summaryEventSchema.parse(await until(() => received[1]));
  assert.equal(created.type, "summary.created");
  assert.deepEqual(
    created,
    (await get(`/events?after_id=${baseline.event_id}`))[0],
  );
  assert.deepEqual(
    created.data.summary,
    (await get(`/summaries/${created.data.summary_id}`)).json,
  );
  const pushed = page.getByRole("status").filter({ hasText: "New summary" });
  await pushed.waitFor();
  const createElapsed = Math.round(performance.now() - createStart);
  assert.equal(
    await pushed.getByRole("link").getAttribute("href"),
    `/summaries/${created.data.summary_id}`,
  );
  const correctionStart = performance.now();
  compose([
    "exec",
    "-T",
    "app",
    "npm",
    "run",
    "demo:replay",
    "--",
    "--correction",
  ]);
  const corrected = summaryEventSchema.parse(await until(() => received[2]));
  assert.equal(corrected.type, "summary.updated");
  assert.equal(corrected.data.revision, 2);
  assert.equal(corrected.data.concall_event_id, created.data.concall_event_id);
  await page
    .getByRole("status")
    .filter({ hasText: "Updated summary" })
    .waitFor();
  const correctionElapsed = Math.round(performance.now() - correctionStart);
  const states = await get("/events");
  await browser.close();
  browser = undefined;
  socket.close();
  socket = undefined;

  // Prove persistence across removal of the container and recreation on the same named volume.
  compose(["down"]);
  compose(["up", "-d", "--wait"]);
  const reopened = `http://${compose(["port", "app", "3000"], { capture: true })}`;
  const response = await fetch(`${reopened}/api/events`, {
    signal: AbortSignal.timeout(5000),
    headers: { Connection: "close" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, states);
  const old = await fetch(
    `${reopened}/api/summaries/${created.data.summary_id}`,
    { signal: AbortSignal.timeout(5000), headers: { Connection: "close" } },
  );
  assert.equal(old.status, 200);
  assert.equal((await old.json()).data.is_current, false);
  console.log(
    JSON.stringify({
      status: "passed",
      mode: "fixture",
      event_ids: states.map(({ event_id }) => event_id),
      revisions: [created.data.revision, corrected.data.revision],
      watchlist: 8,
      origin,
      full_native_events: true,
      browser_updates: 2,
      recreated_with_same_history: true,
      replay_to_ui_ms: createElapsed,
      correction_to_ui_ms: correctionElapsed,
    }),
  );
} finally {
  socket?.close();
  await browser?.close();
  // Only the randomly named project and volume created by this smoke test are removed.
  compose(["down", "--volumes"]);
}
