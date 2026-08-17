import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { deleteOldRawEvents, deleteOldTraces } from "../../src/cleanup.js";

const OLD_DATE = new Date("2020-01-01T00:00:00Z");
const RECENT_DATE = new Date(Date.now() + 86400000);

describe("cleanup retention", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("deletes processed rows older than retention days", async () => {
    const db = getTestDb();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ old: true }),
      processing_status: "processed",
      received_at: OLD_DATE,
      processed_at: OLD_DATE,
      attempt_count: 1,
    }).returning("id").executeTakeFirstOrThrow();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(1);
  });

  it("deletes failed rows older than retention days", async () => {
    const db = getTestDb();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ old: true }),
      processing_status: "failed",
      received_at: OLD_DATE,
      processing_error: "error",
      attempt_count: 5,
    }).returning("id").executeTakeFirstOrThrow();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(1);
  });

  it("does not delete pending rows regardless of age", async () => {
    const db = getTestDb();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ pending: true }),
      processing_status: "pending",
      received_at: OLD_DATE,
      attempt_count: 0,
    }).returning("id").executeTakeFirstOrThrow();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(0);
  });

  it("does not delete recent processed rows", async () => {
    const db = getTestDb();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ recent: true }),
      processing_status: "processed",
      received_at: RECENT_DATE,
      processed_at: RECENT_DATE,
      attempt_count: 1,
    }).returning("id").executeTakeFirstOrThrow();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(0);
  });

  it("deletes only rows older than the configured retention window", async () => {
    const db = getTestDb();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ old: true }),
      processing_status: "processed",
      received_at: OLD_DATE,
      processed_at: OLD_DATE,
      attempt_count: 1,
    }).returning("id").executeTakeFirstOrThrow();

    await db.insertInto("raw_events").values({
      payload: JSON.stringify({ recent: true }),
      processing_status: "processed",
      received_at: RECENT_DATE,
      processed_at: RECENT_DATE,
      attempt_count: 1,
    }).returning("id").executeTakeFirstOrThrow();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(1);

    const remaining = await db
      .selectFrom("raw_events")
      .selectAll()
      .execute();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.processing_status).toBe("processed");
    expect(remaining[0]?.payload).toEqual({ recent: true });
  });

  it("returns 0 when there are no deletable rows", async () => {
    const db = getTestDb();

    const deleted = await deleteOldRawEvents(db, 7);
    expect(deleted).toBe(0);
  });
});

describe("traces retention cleanup", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seedTrace(receivedAt: Date, withGenerations = true): Promise<void> {
    const db = getTestDb();
    const trace = await db
      .insertInto("traces")
      .values({
        openrouter_trace_id: `trace-${receivedAt.getTime()}-${Math.random()}`,
        received_at: receivedAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (withGenerations) {
      await db
        .insertInto("llm_generations")
        .values({
          trace_id: trace.id,
          span_id: `span-${receivedAt.getTime()}-${Math.random()}`,
          start_time: receivedAt,
          request_model: "test-model",
          input_tokens: 10,
          output_tokens: 5,
        })
        .execute();
    }
  }

  it("deletes traces older than retention days and cascades generations", async () => {
    const db = getTestDb();
    await seedTrace(OLD_DATE);
    await seedTrace(RECENT_DATE);

    const deleted = await deleteOldTraces(db, 30);
    expect(deleted).toBe(1);

    const remainingTraces = await db.selectFrom("traces").selectAll().execute();
    expect(remainingTraces).toHaveLength(1);

    const remainingGenerations = await db
      .selectFrom("llm_generations")
      .selectAll()
      .execute();
    expect(remainingGenerations).toHaveLength(1);
  });

  it("does not delete recent traces", async () => {
    const db = getTestDb();
    await seedTrace(RECENT_DATE, false);

    const deleted = await deleteOldTraces(db, 30);
    expect(deleted).toBe(0);

    const remaining = await db.selectFrom("traces").selectAll().execute();
    expect(remaining).toHaveLength(1);
  });

  it("returns 0 when there are no traces at all", async () => {
    const db = getTestDb();
    const deleted = await deleteOldTraces(db, 30);
    expect(deleted).toBe(0);
  });
});
