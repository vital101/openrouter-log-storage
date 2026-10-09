import { describe, it, expect, beforeEach } from "vitest";
import { pino } from "pino";
import { getTestDb, seedRawEvent, truncateAll } from "../fixtures/db.js";
import { processBatch } from "../../src/worker/processBatch.js";
import {
  makeMinimalValidOtel,
  makeOtelPayload,
  makeResourceSpan,
  makeScopeSpan,
  makeSpan,
  makeStringAttr,
} from "../fixtures/otel_payloads.js";

const DEPS = {
  batchSize: 100,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
  concurrency: 1,
};

const logger = pino({ level: "silent" });

describe("processBatch", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns processed=0, failed=0 when there are no pending rows", async () => {
    const db = getTestDb();
    const result = await processBatch({ db, logger, ...DEPS });
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it("processes a valid payload, marks the row processed, and writes traces/generations", async () => {
    const db = getTestDb();
    await seedRawEvent(makeMinimalValidOtel());

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.processing_status).toBe("processed");
    expect(row.processed_at).not.toBeNull();

    const traces = await db
      .selectFrom("traces")
      .selectAll()
      .execute();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.openrouter_trace_id).toBe("or-trace-1");

    const generations = await db
      .selectFrom("llm_generations")
      .selectAll()
      .execute();
    expect(generations).toHaveLength(1);
    expect(generations[0]?.span_id).toBe("span-A");
  });

  it("processes a payload whose inner JSON contains NUL and lone surrogates", async () => {
    const db = getTestDb();
    const payload = makeOtelPayload({
      resourceSpans: [
        makeResourceSpan({
          resourceAttributes: [
            makeStringAttr("openrouter.trace.id", "or-unicode"),
          ],
          scopeSpans: [
            makeScopeSpan({
              spans: [
                makeSpan({
                  spanId: "span-unicode",
                  attributes: [
                    {
                      key: "gen_ai.prompt",
                      value: {
                        stringValue: '{"content":"29.8.2\\n \\u0000tail"}',
                      },
                    },
                    {
                      key: "gen_ai.completion",
                      value: { stringValue: '["ok\\ud800"]' },
                    },
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    await seedRawEvent(payload);

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result).toEqual({ processed: 1, failed: 0 });

    const generation = await db
      .selectFrom("llm_generations")
      .select(["prompt", "completion"])
      .executeTakeFirstOrThrow();
    expect(generation.prompt).toEqual({ content: "29.8.2\n \uFFFDtail" });
    expect(generation.completion).toEqual(["ok\uFFFD"]);
  });

  it("on parse failure increments attempt_count and schedules a backoff", async () => {
    const db = getTestDb();
    await seedRawEvent({ not: "a valid otel payload" });

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);

    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.processing_status).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.processing_error).toBeTruthy();
    expect(row.next_attempt_at).not.toBeNull();
  });

  it("marks the row failed when attempt_count would reach maxAttempts", async () => {
    const db = getTestDb();
    await db
      .insertInto("raw_events")
      .values({
        payload: JSON.stringify({ not: "otel" }),
        auth_header_name: "X",
        attempt_count: DEPS.maxAttempts - 1,
      })
      .execute();

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.failed).toBe(1);

    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.processing_status).toBe("failed");
    expect(row.attempt_count).toBe(DEPS.maxAttempts);
    expect(row.next_attempt_at).toBeNull();
  });

  it("reaps a stale 'processing' row back to pending and re-claims it", async () => {
    const db = getTestDb();
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
    await db
      .insertInto("raw_events")
      .values({
        payload: JSON.stringify(makeMinimalValidOtel()),
        auth_header_name: "X",
        processing_status: "processing",
        claimed_at: sixMinAgo,
      })
      .execute();

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.processed).toBe(1);

    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.processing_status).toBe("processed");
  });

  it("claims at most batchSize rows in a single call", async () => {
    const db = getTestDb();
    for (let i = 0; i < 3; i++) {
      await seedRawEvent(makeMinimalValidOtel());
    }

    const result = await processBatch({ db, logger, ...DEPS, batchSize: 2 });
    expect(result.processed).toBe(2);

    const remaining = await db
      .selectFrom("raw_events")
      .selectAll()
      .where("processing_status", "=", "pending")
      .execute();
    expect(remaining).toHaveLength(1);
  });

  it("does not claim rows whose next_attempt_at is in the future", async () => {
    const db = getTestDb();
    const future = new Date(Date.now() + 60_000);
    await db
      .insertInto("raw_events")
      .values({
        payload: JSON.stringify(makeMinimalValidOtel()),
        auth_header_name: "X",
        next_attempt_at: future,
      })
      .execute();

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.processed).toBe(0);

    const row = await db
      .selectFrom("raw_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.processing_status).toBe("pending");
  });

  it("converges: running processBatch twice is idempotent on already-processed rows", async () => {
    const db = getTestDb();
    await seedRawEvent(makeMinimalValidOtel());

    await processBatch({ db, logger, ...DEPS });
    const second = await processBatch({ db, logger, ...DEPS });
    expect(second.processed).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("processes a payload with two resourceSpans sharing openrouter.trace.id", async () => {
    const db = getTestDb();
    const payload = makeOtelPayload({
      resourceSpans: [
        makeResourceSpan({
          resourceAttributes: [
            makeStringAttr("openrouter.trace.id", "or-shared"),
          ],
          scopeSpans: [makeScopeSpan({ spans: [makeSpan({ spanId: "span-A" })] })],
        }),
        makeResourceSpan({
          resourceAttributes: [
            makeStringAttr("openrouter.trace.id", "or-shared"),
          ],
          scopeSpans: [makeScopeSpan({ spans: [makeSpan({ spanId: "span-B" })] })],
        }),
      ],
    });
    await seedRawEvent(payload);

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const traces = await db.selectFrom("traces").selectAll().execute();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.openrouter_trace_id).toBe("or-shared");

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id"])
      .orderBy("span_id", "asc")
      .execute();
    expect(generations.map((g) => g.span_id)).toEqual(["span-A", "span-B"]);
  });

  it("skips spans with no spanId without failing the batch", async () => {
    const db = getTestDb();
    const payload = makeOtelPayload({
      resourceSpans: [
        makeResourceSpan({
          resourceAttributes: [
            makeStringAttr("openrouter.trace.id", "or-skip"),
          ],
          scopeSpans: [
            makeScopeSpan({
              spans: [
                { traceId: "otel-skip" },
                makeSpan({ spanId: "kept" }),
              ],
            }),
          ],
        }),
      ],
    });
    await seedRawEvent(payload);

    const result = await processBatch({ db, logger, ...DEPS });
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const traces = await db.selectFrom("traces").selectAll().execute();
    expect(traces).toHaveLength(1);

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id"])
      .execute();
    expect(generations.map((g) => g.span_id)).toEqual(["kept"]);
  });
});
