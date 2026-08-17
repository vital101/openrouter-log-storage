import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { createTestApp } from "../fixtures/app.js";
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
    const res = await request(app)
      .post("/webhook/openrouter")
      .send({ resourceSpans: [] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "missing_auth_header" });
  });

  it("rejects requests with a wrong auth header", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, "wrong")
      .send({ resourceSpans: [] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_auth" });
  });

  it("short-circuits with x-test-connection: true and writes no row", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, SECRET)
      .set("x-test-connection", "true")
      .send({ resourceSpans: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, test: true });

    const db = getTestDb();
    const rows = await db.selectFrom("raw_events").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("accepts a valid object body, persists a row, and returns its id", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const body = { resourceSpans: [] };
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, SECRET)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe("number");

    const db = getTestDb();
    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .where("id", "=", Number(res.body.id))
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual(body);
    expect(row.auth_header_name).toBe(HEADER);
    expect(row.processing_status).toBe("pending");
  });

  it("rejects an array body with 400 invalid_payload", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, SECRET)
      .set("Content-Type", "application/json")
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_payload" });
  });

  it("rejects malformed JSON with 400 invalid_json", async () => {
    const app = createTestApp({ db: getTestDb(), config });
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, SECRET)
      .set("Content-Type", "application/json")
      .send("{ not valid");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });

  it("rejects oversized bodies with 413 payload_too_large", async () => {
    const small = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRET_HEADER: HEADER,
      WEBHOOK_BODY_LIMIT: "10b",
    });
    const app = createTestApp({ db: getTestDb(), config: small });
    const big = { x: "a".repeat(200) };
    const res = await request(app)
      .post("/webhook/openrouter")
      .set(HEADER, SECRET)
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload_too_large" });
  });

  it("honors a custom WEBHOOK_SECRET_HEADER for auth and records it", async () => {
    const custom = buildConfig({
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_SECRET_HEADER: "X-Custom-Auth",
    });
    const app = createTestApp({ db: getTestDb(), config: custom });
    const res = await request(app)
      .post("/webhook/openrouter")
      .set("X-Custom-Auth", SECRET)
      .send({ hello: "world" });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const row = await db
      .selectFrom("raw_events")
      .select(["auth_header_name", "payload"])
      .where("id", "=", Number(res.body.id))
      .executeTakeFirstOrThrow();
    expect(row.auth_header_name).toBe("X-Custom-Auth");
  });
});
