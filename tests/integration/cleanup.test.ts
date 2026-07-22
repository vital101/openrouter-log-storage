import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { deleteOldRawEvents } from "../../src/cleanup.js";

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
