import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig } from "../src/config/env.js";
import { openDatabase } from "../src/config/database.js";
import { startApi } from "../src/index.js";

// Exercise the production bootstrap twice on one isolated data directory and an ephemeral port.
const root = mkdtempSync(path.join(tmpdir(), "finosauras-smoke-"));
const config = {
  ...readConfig({
    DATA_DIR: root,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    FIXTURE_WATCH_ENABLED: "false",
  }),
  PORT: 0,
};
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { server, close } = await startApi(config);
    try {
      for (const [probe, status] of [
        ["live", "ok"],
        ["ready", "ready"],
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/health/${probe}`,
          {
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.status, status);
        assert.equal(body.meta.mode, "fixture");
      }
    } finally {
      await close();
    }
  }
  assert.ok(existsSync(config.DATABASE_PATH));
  const db = openDatabase(config);
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM companies").get().count,
      8,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM schema_migrations").get().count,
      10,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM source_filings").get().count,
      0,
    );
  } finally {
    db.close();
  }
  console.log(
    "Stage 1 smoke passed: two boots, live and ready HTTP 200, ten migrations, eight companies.",
  );
} finally {
  rmSync(root, { recursive: true });
}
