import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { pino } from "pino";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { createTestApp } from "../fixtures/app.js";
import { startWorkerLoop } from "../../src/worker/index.js";
import { makeMinimalValidOtel, makeOtelPayload, makeResourceSpan, makeScopeSpan, makeSpan, makeStringAttr } from "../fixtures/otel_payloads.js";
import type { Config } from "../../src/config.js";

const SECRET = "e2e-secret";
const HEADER = "X-Webhook-Signature";

const TEST_CONFIG: Config = {
  PORT: 3000,
  DATABASE_URL: "postgres://test",
  WEBHOOK_SECRET: SECRET,
  WEBHOOK_SECRET_HEADER: HEADER,
  LOG_LEVEL: "silent",
  WORKER_POLL_INTERVAL_MS: 60_000,
  WORKER_BATCH_SIZE: 100,
  WEBHOOK_BODY_LIMIT: "10mb",
  NODE_ENV: "test",
  MAX_PROCESSING_ATTEMPTS: 5,
  WORKER_BACKOFF_BASE_MS: 1_000,
  WORKER_BACKOFF_MAX_MS: 300_000,
  RAW_EVENT_RETENTION_DAYS: 7,
  DB_POOL_MAX: 10,
  WORKER_CONCURRENCY: 1,
  WEBHOOK_SECRETS: undefined,
  WEBHOOK_RATE_LIMIT_PER_MIN: 0,
};

const logger = pino({ level: "silent" });

describe("server + worker e2e", () => {
  beforeEach(async () => {
    await truncateAll();
  });


  it("ingests a webhook, processes it via a worker tick, and writes traces+generations", async () => {
    const db = getTestDb();
    const app = createTestApp({ db, config: TEST_CONFIG });
    const worker = startWorkerLoop({ db, logger, config: TEST_CONFIG });

    try {
      const payload = makeMinimalValidOtel();
      const res = await request(app)
        .post("/webhook/openrouter")
        .set(HEADER, SECRET)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const rawEventId = Number(res.body.id);

      await worker.tick();

      const rawRow = await db
        .selectFrom("raw_events")
        .select(["processing_status", "processed_at"])
        .where("id", "=", rawEventId)
        .executeTakeFirstOrThrow();
      expect(rawRow.processing_status).toBe("processed");
      expect(rawRow.processed_at).not.toBeNull();

      const traces = await db
        .selectFrom("traces")
        .selectAll()
        .execute();
      expect(traces).toHaveLength(1);
      expect(traces[0]?.openrouter_trace_id).toBe("or-trace-1");
      expect(traces[0]?.raw_event_id).toBe(rawEventId);
      expect(traces[0]?.service_name).toBe("test-service");

      const generations = await db
        .selectFrom("llm_generations")
        .selectAll()
        .execute();
      expect(generations).toHaveLength(1);
      expect(generations[0]?.span_id).toBe("span-A");
      expect(generations[0]?.request_model).toBe("gpt-4o");
      expect(generations[0]?.input_tokens).toBe(100);
    } finally {
      await worker.stop();
    }
  });

  it("rejected auth requests do not write any data and the worker is a no-op", async () => {
    const db = getTestDb();
    const app = createTestApp({ db, config: TEST_CONFIG });
    const worker = startWorkerLoop({ db, logger, config: TEST_CONFIG });

    try {
      const res = await request(app)
        .post("/webhook/openrouter")
        .set(HEADER, "wrong")
        .send(makeMinimalValidOtel());
      expect(res.status).toBe(401);

      await worker.tick();

      const rawCount = await db
        .selectFrom("raw_events")
        .select((eb) => eb.fn.count("id").as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(rawCount.c)).toBe(0);

      const traceCount = await db
        .selectFrom("traces")
        .select((eb) => eb.fn.count("id").as("c"))
        .executeTakeFirstOrThrow();
      expect(Number(traceCount.c)).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it("re-emitting a trace with fewer spans removes the orphan generations", async () => {
    const db = getTestDb();
    const app = createTestApp({ db, config: TEST_CONFIG });
    const worker = startWorkerLoop({ db, logger, config: TEST_CONFIG });

    try {
      const full = makeOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("openrouter.trace.id", "or-trace-1")],
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({ spanId: "span-A" }),
                  makeSpan({ spanId: "span-B" }),
                  makeSpan({ spanId: "span-C" }),
                ],
              }),
            ],
          }),
        ],
      });
      const res1 = await request(app)
        .post("/webhook/openrouter")
        .set(HEADER, SECRET)
        .send(full);
      expect(res1.status).toBe(200);
      await worker.tick();

      const partial = makeOtelPayload({
        resourceSpans: [
          makeResourceSpan({
            resourceAttributes: [makeStringAttr("openrouter.trace.id", "or-trace-1")],
            scopeSpans: [
              makeScopeSpan({
                spans: [
                  makeSpan({ spanId: "span-A" }),
                  makeSpan({ spanId: "span-B" }),
                ],
              }),
            ],
          }),
        ],
      });
      const res2 = await request(app)
        .post("/webhook/openrouter")
        .set(HEADER, SECRET)
        .send(partial);
      expect(res2.status).toBe(200);
      await worker.tick();

      const traces = await db
        .selectFrom("traces")
        .selectAll()
        .execute();
      expect(traces).toHaveLength(1);

      const generations = await db
        .selectFrom("llm_generations")
        .select(["span_id"])
        .orderBy("span_id", "asc")
        .execute();
      expect(generations.map((g) => g.span_id)).toEqual(["span-A", "span-B"]);
    } finally {
      await worker.stop();
    }
  });
});
