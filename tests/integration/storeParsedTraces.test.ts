import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, seedRawEvent, truncateAll } from "../fixtures/db.js";
import { storeParsedTraces } from "../../src/worker/store.js";
import { makeParsedTraceFor } from "../fixtures/otel_payloads.js";

describe("storeParsedTraces", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("inserts a new trace and its generations", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({ resourceSpans: [] });
    const parsed = makeParsedTraceFor("or-trace-1", ["span-A", "span-B"]);

    await storeParsedTraces(db, rawEventId, parsed);

    const traces = await db
      .selectFrom("traces")
      .selectAll()
      .execute();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.openrouter_trace_id).toBe("or-trace-1");
    expect(traces[0]?.raw_event_id).toBe(rawEventId);

    const generations = await db
      .selectFrom("llm_generations")
      .selectAll()
      .orderBy("span_id", "asc")
      .execute();
    expect(generations).toHaveLength(2);
    expect(generations.map((g) => g.span_id)).toEqual(["span-A", "span-B"]);
  });

  it("upserts on conflict — updating the existing trace row", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed1 = makeParsedTraceFor("or-trace-1", ["span-A"]);
    await storeParsedTraces(db, rawEventId, parsed1);

    const parsed2 = makeParsedTraceFor("or-trace-1", ["span-A"]);
    if (parsed2[0]) {
      parsed2[0].trace.traceName = "updated-name";
      parsed2[0].trace.environment = "prod";
    }
    await storeParsedTraces(db, rawEventId, parsed2);

    const traces = await db
      .selectFrom("traces")
      .selectAll()
      .execute();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.trace_name).toBe("updated-name");
    expect(traces[0]?.environment).toBe("prod");
  });

  it("deletes generations for a trace that are not in the incoming set", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed1 = makeParsedTraceFor("or-trace-1", ["span-A", "span-B", "span-C"]);
    await storeParsedTraces(db, rawEventId, parsed1);

    const parsed2 = makeParsedTraceFor("or-trace-1", ["span-A", "span-B"]);
    await storeParsedTraces(db, rawEventId, parsed2);

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id"])
      .orderBy("span_id", "asc")
      .execute();
    expect(generations.map((g) => g.span_id)).toEqual(["span-A", "span-B"]);
  });

  it("upserts an existing generation (same span_id) and adds a new one", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    await storeParsedTraces(db, rawEventId, makeParsedTraceFor("or-trace-1", ["span-A"]));

    const parsed2 = makeParsedTraceFor("or-trace-1", ["span-A", "span-B"]);
    if (parsed2[0]?.generations[0]) {
      parsed2[0].generations[0].outputTokens = 999;
    }
    await storeParsedTraces(db, rawEventId, parsed2);

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id", "output_tokens"])
      .orderBy("span_id", "asc")
      .execute();
    expect(generations).toHaveLength(2);
    const a = generations.find((g) => g.span_id === "span-A");
    expect(a?.output_tokens).toBe(999);
  });

  it("round-trips array tags as a JSON array", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed = makeParsedTraceFor("or-trace-1", ["span-A"]);
    if (parsed[0]) {
      parsed[0].trace.tags = ["red", "blue"];
    }
    await storeParsedTraces(db, rawEventId, parsed);

    const row = await db
      .selectFrom("traces")
      .select(["tags"])
      .where("openrouter_trace_id", "=", "or-trace-1")
      .executeTakeFirstOrThrow();
    expect(row.tags).toEqual(["red", "blue"]);
  });

  it("inserts trace row but no generations when generations is empty", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed = makeParsedTraceFor("or-trace-1", []);
    await storeParsedTraces(db, rawEventId, parsed);

    const traces = await db.selectFrom("traces").selectAll().execute();
    expect(traces).toHaveLength(1);
    const generations = await db.selectFrom("llm_generations").selectAll().execute();
    expect(generations).toHaveLength(0);
  });

  it("inserts multiple traces in one call", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const allParsed = [
      ...makeParsedTraceFor("or-trace-A", ["s1"]),
      ...makeParsedTraceFor("or-trace-B", ["s2", "s3"]),
    ];
    await storeParsedTraces(db, rawEventId, allParsed);

    const traces = await db.selectFrom("traces").selectAll().execute();
    expect(traces).toHaveLength(2);
    const generations = await db
      .selectFrom("llm_generations")
      .selectAll()
      .execute();
    expect(generations).toHaveLength(3);
  });

  it("coalesces two parsed payloads that share an openrouter_trace_id into one trace row", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed = [
      ...makeParsedTraceFor("or-shared", ["span-A"]),
      ...makeParsedTraceFor("or-shared", ["span-B"]),
    ];
    await storeParsedTraces(db, rawEventId, parsed);

    const traces = await db
      .selectFrom("traces")
      .selectAll()
      .execute();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.openrouter_trace_id).toBe("or-shared");

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id"])
      .orderBy("span_id", "asc")
      .execute();
    expect(generations.map((g) => g.span_id)).toEqual(["span-A", "span-B"]);
  });

  it("deduplicates spans that share a span_id within a coalesced group (first wins)", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed = [
      ...makeParsedTraceFor("or-dup-spans", ["span-X"]),
      ...makeParsedTraceFor("or-dup-spans", ["span-X", "span-Y"]),
    ];
    await storeParsedTraces(db, rawEventId, parsed);

    const generations = await db
      .selectFrom("llm_generations")
      .select(["span_id"])
      .orderBy("span_id", "asc")
      .execute();
    expect(generations.map((g) => g.span_id)).toEqual(["span-X", "span-Y"]);
  });

  it("later payloads' top-level trace fields win when coalesced", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    const parsed = [
      ...makeParsedTraceFor("or-merge", ["span-A"]),
    ];
    if (parsed[0]) {
      parsed[0].trace.environment = "first";
    }
    const parsed2 = [...makeParsedTraceFor("or-merge", ["span-B"])];
    if (parsed2[0]) {
      parsed2[0].trace.environment = "second";
    }
    await storeParsedTraces(db, rawEventId, [...parsed, ...parsed2]);

    const trace = await db
      .selectFrom("traces")
      .select(["environment"])
      .where("openrouter_trace_id", "=", "or-merge")
      .executeTakeFirstOrThrow();
    expect(trace.environment).toBe("second");
  });

  it("is a no-op when parsed is empty", async () => {
    const db = getTestDb();
    const rawEventId = await seedRawEvent({});
    await expect(storeParsedTraces(db, rawEventId, [])).resolves.toBeUndefined();

    const traces = await db.selectFrom("traces").selectAll().execute();
    expect(traces).toHaveLength(0);
  });
});
