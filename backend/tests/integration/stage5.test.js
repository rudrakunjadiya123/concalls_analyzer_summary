import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { summaryEventSchema } from "@finosauras/shared";
import { readConfig } from "../../src/config/env.js";
import { openDatabase } from "../../src/config/database.js";
import { requestReplay } from "../../src/services/ingestion/replay.js";
import { startApi } from "../../src/index.js";
import { exportApprovedSample } from "../../src/cli/exportSamples.js";

describe("Stage 5 HTTP, WebSocket, and durable replay", () => {
  let root, config, api, base, clients;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fin-stage5-"));
    config = {
      ...readConfig({ DATA_DIR: root, HOST: "127.0.0.1", LOG_LEVEL: "silent" }),
      PORT: 0,
    };
    clients = [];
  });
  afterEach(async () => {
    for (const ws of clients) ws.terminate();
    await api?.close();
    api = undefined;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function start(overrides = {}) {
    api = await startApi({ ...config, ...overrides });
    base = `http://127.0.0.1:${api.server.address().port}`;
  }
  async function request(route, options) {
    return fetch(`${base}${route}`, {
      signal: AbortSignal.timeout(5000),
      ...options,
    });
  }
  async function get(route) {
    const response = await request(`/api${route}`);
    expect(response.status, route).toBe(200);
    return response.json();
  }
  async function waitFor(expectation) {
    let error;
    for (let index = 0; index < 110; index++) {
      try {
        return await expectation();
      } catch (failure) {
        error = failure;
      }
      await sleep(100);
    }
    throw error;
  }
  function queue(variant) {
    const db = openDatabase(config);
    try {
      return requestReplay(db, config, variant);
    } finally {
      db.close();
    }
  }
  async function connect() {
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws/summaries`);
    const messages = [];
    ws.on("message", (value) => messages.push(JSON.parse(value)));
    clients.push(ws);
    await once(ws, "open");
    await waitFor(() => expect(messages[0]?.type).toBe("connected"));
    return { ws, messages };
  }

  it("serves stable envelopes, validates route input, and protects private storage", async () => {
    await start({ FIXTURE_WATCH_ENABLED: false });
    expect((await get("/health/live")).data.status).toBe("ok");
    expect((await get("/health/ready")).data.status).toBe("ready");
    const status = (await get("/status")).data;
    expect(status).toMatchObject({
      data_mode: "fixture",
      processed_companies: 0,
      published_summaries: 0,
      last_event_id: 0,
      ws_clients: 0,
    });
    for (const key of ["NSE", "BSE"])
      expect(status.sources[key]).toMatchObject({
        authorized: false,
        enabled: false,
      });
    const watchlist = (await get("/watchlist")).data;
    expect(watchlist).toHaveLength(8);
    expect(
      watchlist.every(
        (row) => row.latest_summary === null && !row.identity_verified,
      ),
    ).toBe(true);
    const page = await get("/companies?limit=3");
    const next = await get(
      `/companies?limit=5&cursor=${page.pagination.next_cursor}`,
    );
    expect([...page.data, ...next.data].map(({ id }) => id)).toEqual(
      watchlist.map(({ id }) => id),
    );
    expect(next.pagination.next_cursor).toBeNull();
    const sector = await get(
      `/companies?sector=${encodeURIComponent(watchlist[0].sector)}`,
    );
    expect(sector.data.every((row) => row.sector === watchlist[0].sector)).toBe(
      true,
    );
    expect(
      (await get(`/companies/${watchlist[0].id}`)).data.latest_event,
    ).toBeNull();
    expect((await get(`/companies/${watchlist[0].id}/summaries`)).data).toEqual(
      [],
    );
    expect((await get("/events/latest")).data).toEqual({ last_event_id: 0 });
    const invalid = [
      "/api/events?after_id=-1",
      "/api/events?after_id=9007199254740992",
      "/api/events?limit=0",
      "/api/events?limit=101",
      "/api/events?limit=no",
      "/api/events?limit=1&limit=2",
      "/api/summaries?include_superseded=1",
      "/api/summaries?cursor=malformed",
      `/api/summaries?cursor=${page.pagination.next_cursor}`,
      "/api/companies/not-a-uuid",
    ];
    for (const route of invalid) {
      const response = await request(route);
      expect(response.status, route).toBe(400);
      expect((await response.json()).error.code).toBe("BAD_REQUEST");
    }
    for (const route of [
      "/data/app.sqlite",
      "/api/files",
      "/api/summaries/00000000-0000-4000-8000-000000000000",
    ]) {
      const response = await request(route);
      expect(response.status, route).toBe(404);
      expect(response.headers.get("x-powered-by")).toBeNull();
      expect(JSON.stringify(await response.json())).not.toContain(root);
    }
    expect(
      (
        await request("/api/summaries", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(404);
    const malformed = await request("/api/summaries", {
      method: "POST",
      body: "{",
      headers: { "Content-Type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("publishes full matching events to two clients, replays a missed correction, and keeps history on restart", async () => {
    await start({ WS_MAX_CLIENTS: 2 });
    const initial = await waitFor(async () => {
      const outbox = (await get("/events")).data;
      expect(outbox).toHaveLength(1);
      return outbox[0];
    });
    const first = await connect();
    const second = await connect();
    expect(first.messages[0]).toEqual({
      schema_version: 1,
      type: "connected",
      data: { last_event_id: initial.event_id, data_mode: "fixture" },
    });
    const denied = new WebSocket(
      `${base.replace("http:", "ws:")}/ws/summaries`,
    );
    clients.push(denied);
    const [, limit] = await once(denied, "unexpected-response");
    expect(limit.statusCode).toBe(429);
    limit.resume();
    denied.on("error", () => {});
    denied.terminate();
    expect((await get("/status")).data.ws_clients).toBe(2);
    first.ws.send('{"type":"scrape","url":"https://example.invalid/private"}');
    second.ws.send("unparseable message");
    await sleep(340);
    expect((await get("/events")).data).toEqual([initial]);
    expect(queue("replay").queued).toBe(true);
    expect(queue("replay").queued).toBe(false);
    const create = await waitFor(() => {
      expect(first.messages).toHaveLength(2);
      expect(second.messages).toEqual(first.messages);
      return summaryEventSchema.parse(first.messages[1]);
    });
    expect(create).toMatchObject({
      type: "summary.created",
      data_mode: "fixture",
      data: { revision: 1, is_mock: true, summary: { source: "FIXTURE" } },
    });
    expect(create.data.summary.company).toMatch(/fictional|synthetic/i);
    expect(create.data.summary.key_metrics.map(({ value }) => value)).toContain(
      "₹430 crore",
    );
    const db = openDatabase(config);
    try {
      const documentHash = db
        .prepare(
          `SELECT d.sha256 FROM summaries s JOIN transcripts t ON t.id=s.transcript_id
        JOIN documents d ON d.id=t.document_id WHERE s.id=?`,
        )
        .pluck()
        .get(create.data.summary_id);
      await expect(
        exportApprovedSample(db, config, {
          summary_id: create.data.summary_id,
          document_sha256: documentHash,
          source_url: "https://example.invalid/filing",
          redistribution_allowed: true,
          authorization_reference: "test grant",
        }),
      ).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
    } finally {
      db.close();
    }
    const detail = (await get(`/summaries/${create.data.summary_id}`)).data;
    expect(detail.json).toEqual(create.data.summary);
    expect(detail.validation).toMatchObject({
      status: "passed",
      evidence_count: expect.any(Number),
    });
    const evidence = (await get(`/summaries/${detail.id}/evidence`)).data;
    expect(evidence).toHaveLength(detail.validation.evidence_count);
    expect(
      evidence.every(
        (row) =>
          row.page_number >= 1 &&
          row.supporting_quote &&
          row.verification_status === "verified",
      ),
    ).toBe(true);
    const markdown = await request(`/api/summaries/${detail.id}/markdown`);
    expect(markdown.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await markdown.text()).toBe(detail.markdown);
    const departed = once(second.ws, "close");
    second.ws.close();
    await departed;
    expect(queue("correction").queued).toBe(true);
    const correction = await waitFor(() => {
      expect(first.messages).toHaveLength(3);
      return first.messages[2];
    });
    expect(correction).toMatchObject({
      type: "summary.updated",
      data: { concall_event_id: create.data.concall_event_id, revision: 2 },
    });
    expect(correction.data.summary_id).not.toBe(detail.id);
    expect(correction.data.summary.call_date).toBe(
      create.data.summary.call_date,
    );
    expect(
      correction.data.summary.key_metrics.map(({ value }) => value),
    ).toContain("₹440 crore");
    expect(second.messages).toHaveLength(2);
    const returning = await connect();
    expect(returning.messages).toEqual([
      {
        schema_version: 1,
        type: "connected",
        data: { last_event_id: correction.event_id, data_mode: "fixture" },
      },
    ]);
    expect((await get(`/events?after_id=${create.event_id}`)).data).toEqual([
      correction,
    ]);
    const page = await get("/events?after_id=0&limit=2");
    expect(page.pagination.next_cursor).toBe(create.event_id);
    expect(page.data).toEqual([initial, create]);
    const companyId = create.data.company_id;
    const history = (await get(`/companies/${companyId}/summaries`)).data;
    expect(
      history
        .filter((row) => row.concall_event_id === create.data.concall_event_id)
        .map(({ revision, is_current }) => [revision, is_current]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await get(`/companies/${companyId}`)).data.latest_summary.id).toBe(
      correction.data.summary_id,
    );
    expect(
      (await get(`/summaries?company_id=${companyId}`)).data.map(
        ({ id }) => id,
      ),
    ).not.toContain(detail.id);
    expect(
      (
        await get(`/summaries?company_id=${companyId}&include_superseded=true`)
      ).data.map(({ id }) => id),
    ).toContain(detail.id);
    const graceful = once(first.ws, "close");
    await api.close();
    api = undefined;
    expect((await graceful)[0]).toBe(1001);
    await start();
    expect((await get("/events")).data).toEqual([initial, create, correction]);
    expect((await get(`/summaries/${detail.id}`)).data).toMatchObject({
      is_current: false,
      markdown: detail.markdown,
    });
    expect(queue("correction").queued).toBe(false);
    expect((await get("/status")).data).toMatchObject({
      published_summaries: 3,
      last_event_id: correction.event_id,
    });
    await api.close();
    api = undefined;
    await start({
      DATA_MODE: "authorized-direct",
      GEMINI_API_KEY: "synthetic-test-key",
    });
    // Switching to an unconfigured real mode must not replay synthetic publications.
    expect(await get("/events/latest")).toMatchObject({
      data: { last_event_id: 0 },
      meta: { mode: "authorized-direct" },
    });
    expect((await get("/summaries")).data).toEqual([]);
    expect((await request(`/api/summaries/${detail.id}`)).status).toBe(404);
    const real = (await get("/status")).data;
    expect(real.scheduler_enabled).toBe(false);
    expect(real.sources.NSE).toMatchObject({
      status: "disabled",
      authorized: false,
    });
    expect(real.sources.BSE).toMatchObject({
      status: "disabled",
      authorized: false,
    });
  }, 25000);

  it("disconnects over-budget and oversized traffic while committed summaries stay available", async () => {
    await start({ WS_MAX_BUFFERED_BYTES: 256 });
    const baseline = await waitFor(async () => {
      const { data } = await get("/events");
      expect(data).toHaveLength(1);
      return data[0].event_id;
    });
    const large = await connect();
    const oversized = once(large.ws, "close");
    large.ws.send("x".repeat(3000));
    expect((await oversized)[0]).toBe(1009);
    const watch = await connect();
    const budget = once(watch.ws, "close");
    expect(queue("replay").queued).toBe(true);
    const event = await waitFor(async () => {
      const { data } = await get(`/events?after_id=${baseline}`);
      expect(data).toHaveLength(1);
      return data[0];
    });
    expect((await budget)[0]).toBe(1006);
    expect(
      (await get(`/summaries/${event.data.summary_id}`)).data.json,
    ).toEqual(event.data.summary);
    expect((await get("/health/ready")).data.status).toBe("ready");
  }, 20000);
});
