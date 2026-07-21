import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../fixtures/app.js";
import { getTestDb } from "../fixtures/db.js";
import type { Config } from "../../src/config.js";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "../../src/types.js";

const TEST_CONFIG: Config = {
  PORT: 3000,
  DATABASE_URL: "postgres://test",
  WEBHOOK_SECRET: "s",
  WEBHOOK_SECRET_HEADER: "X-Webhook-Signature",
  LOG_LEVEL: "silent",
  WORKER_POLL_INTERVAL_MS: 5_000,
  WORKER_BATCH_SIZE: 100,
  WEBHOOK_BODY_LIMIT: "10mb",
  NODE_ENV: "test",
  MAX_PROCESSING_ATTEMPTS: 5,
  WORKER_BACKOFF_BASE_MS: 1_000,
  WORKER_BACKOFF_MAX_MS: 300_000,
};

describe("GET /healthz", () => {
  it("returns 200 {status:ok} when the database responds", async () => {
    const app = createTestApp({ db: getTestDb(), config: TEST_CONFIG });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns 503 {status:down,error} when the database is unreachable", async () => {
    const badDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString:
            "postgres://nope:nope@127.0.0.1:1/nope?connectionTimeoutMillis=500",
          max: 1,
        }),
      }),
    });
    const app = createTestApp({ db: badDb, config: TEST_CONFIG });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(typeof res.body.error).toBe("string");
    await badDb.destroy();
  });
});
