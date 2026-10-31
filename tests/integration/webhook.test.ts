import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { createTestApp } from "../fixtures/app.js";
import { call } from "../fixtures/http.js";
import type { Config } from "../../src/config.js";

const SECRET = "test-secret";
const HEADER = "X-Webhook-Signature";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 3000,
    DATABASE_URL: "postgres://test",
    WEBHOOK_SECRET: SECRET,
    WEBHOOK_SECRET_HEADER: HEADER,
    LOG_LEVEL: "silent",
    WORKER_POLL_INTERVAL_MS: 5_000,
    WORKER_BATCH_SIZE: 100,
    WEBHOOK_BODY_LIMIT: "1mb",
    NODE_ENV: "test",
    MAX_PROCESSING_ATTEMPTS: 5,
    WORKER_BACKOFF_BASE_MS: 1_000,
    WORKER_BACKOFF_MAX_MS: 300_000,
    RAW_EVENT_RETENTION_DAYS: 7,
    TRACES_RETENTION_DAYS: 30,
    DB_POOL_MAX: 10,
    WORKER_CONCURRENCY: 1,
    WEBHOOK_SECRETS: undefined,
    WEBHOOK_RATE_LIMIT_PER_MIN: 0,
    ...overrides,
  };
}

describe("POST /webhook/openrouter", () => {
  let config: Config;

  beforeEach(async () => {
    await truncateAll();
    config = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRET_HEADER: HEADER,
      WEBHOOK_BODY_LIMIT: "1mb",
    });
  });

  afterEach(async () => {
    await truncateAll();
  });

  it("rejects requests with a missing auth header", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      json: { resourceSpans: [] },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_auth_header" });
  });

  it("rejects requests with a wrong auth header", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: "wrong" },
      json: { resourceSpans: [] },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_auth" });
  });

  it("short-circuits with x-test-connection: true and writes no row", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "x-test-connection": "true" },
      json: { resourceSpans: [] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, test: true });

    const db = getTestDb();
    const rows = await db.selectFrom("raw_events").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("accepts a valid object body, persists a row, and returns its id", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const body = { resourceSpans: [] };
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET },
      json: body,
    });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { ok: boolean; id: number };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.id).toBe("number");

    const db = getTestDb();
    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .where("id", "=", Number(parsed.id))
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual(body);
    expect(row.auth_header_name).toBe(HEADER);
    expect(row.processing_status).toBe("pending");
  });

  it("rejects an array body with 400 invalid_payload", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET },
      json: [1, 2, 3],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payload" });
  });

  it("rejects malformed JSON with 400 invalid_json", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "content-type": "application/json" },
      body: "{ not valid",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("rejects primitive JSON bodies with 400 invalid_json (strict mode)", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "content-type": "application/json" },
      body: '"just a string"',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("rejects oversized bodies with 413 payload_too_large", async () => {
    const small = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRET_HEADER: HEADER,
      WEBHOOK_BODY_LIMIT: "10b",
    });
    const app = createTestApp({ db: getTestDb(), config: small });
    const big = { x: "a".repeat(200) };
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET },
      json: big,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("sanitizes unicode that Postgres cannot store before persisting", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const body = JSON.parse(
      '{"text":"a\\u0000b","lone":"\\ud800"}',
    ) as Record<string, unknown>;
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET },
      json: body,
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const parsed = (await res.json()) as { id: number };
    const row = await db
      .selectFrom("raw_events")
      .select(["payload"])
      .where("id", "=", Number(parsed.id))
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual({ text: "a\uFFFDb", lone: "\uFFFD" });
  });

  it("honors a custom WEBHOOK_SECRET_HEADER for auth and records it", async () => {
    const custom = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRET_HEADER: "X-Custom-Auth",
    });
    const app = createTestApp({ db: getTestDb(), config: custom });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { "X-Custom-Auth": SECRET },
      json: { hello: "world" },
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const parsed = (await res.json()) as { id: number };
    const row = await db
      .selectFrom("raw_events")
      .select(["auth_header_name", "payload"])
      .where("id", "=", Number(parsed.id))
      .executeTakeFirstOrThrow();
    expect(row.auth_header_name).toBe("X-Custom-Auth");
  });

  it("accepts a request with a valid rotated secret", async () => {
    const rotated = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRETS: "old-secret,new-secret",
    });
    const app = createTestApp({ db: getTestDb(), config: rotated });
    const res = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: "new-secret" },
      json: { ok: 1 },
    });
    expect(res.status).toBe(200);
  });

  it("rate-limits after the configured number of requests per minute", async () => {
    const limited = buildConfig({ WEBHOOK_RATE_LIMIT_PER_MIN: 2 });
    const app = createTestApp({ db: getTestDb(), config: limited });

    const first = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "x-forwarded-for": "10.0.0.1" },
      json: { n: 1 },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe("2");

    const second = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "x-forwarded-for": "10.0.0.1" },
      json: { n: 2 },
    });
    expect(second.status).toBe(200);

    const third = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "x-forwarded-for": "10.0.0.1" },
      json: { n: 3 },
    });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });

    // A different client is unaffected.
    const other = await call(app, "/webhook/openrouter", {
      method: "POST",
      headers: { [HEADER]: SECRET, "x-forwarded-for": "10.0.0.2" },
      json: { n: 4 },
    });
    expect(other.status).toBe(200);
  });

  it("exempts x-test-connection probes from rate limiting", async () => {
    const limited = buildConfig({ WEBHOOK_RATE_LIMIT_PER_MIN: 1 });
    const app = createTestApp({ db: getTestDb(), config: limited });

    for (let i = 0; i < 5; i++) {
      const res = await call(app, "/webhook/openrouter", {
        method: "POST",
        headers: {
          [HEADER]: SECRET,
          "x-test-connection": "true",
          "x-forwarded-for": "10.0.0.3",
        },
        json: {},
      });
      expect(res.status).toBe(200);
    }
  });
});
