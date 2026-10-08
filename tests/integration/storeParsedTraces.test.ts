import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "kysely";
import { getTestDb, seedRawEvent, truncateAll } from "../fixtures/db.js";
import { storeParsedTraces } from "../../src/worker/store.js";
import { makeParsedTraceFor } from "../fixtures/otel_payloads.js";

interface UsageDailyRow {
  day: string;
  model: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  reasoning_tokens: string;
  total_tokens: string;
  total_cost: string;
}

async function selectUsageDaily(): Promise<UsageDailyRow[]> {
  const result = await sql<UsageDailyRow>`
    SELECT day::text AS day, model, calls::text AS calls,
           input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
           cached_tokens::text AS cached_tokens, reasoning_tokens::text AS reasoning_tokens,
           total_tokens::text AS total_tokens, total_cost::text AS total_cost
    FROM usage_daily
    ORDER BY day, model
  `.execute(getTestDb());
  return result.rows;
}

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

  describe("usage_daily rollup", () => {
    it("maintains buckets for stored generations", async () => {
      const db = getTestDb();
      const rawEventId = await seedRawEvent({});
      await storeParsedTraces(db, rawEventId, makeParsedTraceFor("or-rollup-1", ["span-A", "span-B"]));

      const rows = await selectUsageDaily();
      expect(rows).toEqual([
        {
          day: "2023-11-14",
          model: "gpt-4o",
          calls: "2",
          input_tokens: "200",
          output_tokens: "100",
          cached_tokens: "0",
          reasoning_tokens: "0",
          total_tokens: "300",
          total_cost: "0.00600000",
        },
      ]);
    });

    it("re-emitting the same spans does not double count", async () => {
      const db = getTestDb();
      const rawEventId = await seedRawEvent({});
      const parsed = makeParsedTraceFor("or-rollup-2", ["span-A", "span-B"]);
      await storeParsedTraces(db, rawEventId, parsed);
      await storeParsedTraces(db, rawEventId, parsed);

      const rows = await selectUsageDaily();
      expect(rows[0]?.calls).toBe("2");
    });

    it("shrinks the bucket when a re-emit removes spans", async () => {
      const db = getTestDb();
      const rawEventId = await seedRawEvent({});
      await storeParsedTraces(db, rawEventId, makeParsedTraceFor("or-rollup-3", ["span-A", "span-B", "span-C"]));
      await storeParsedTraces(db, rawEventId, makeParsedTraceFor("or-rollup-3", ["span-A"]));

      const rows = await selectUsageDaily();
      expect(rows[0]?.calls).toBe("1");
      expect(rows[0]?.input_tokens).toBe("100");
    });

    it("splits buckets by UTC day and request model", async () => {
      const db = getTestDb();
      const rawEventId = await seedRawEvent({});
      const parsed = makeParsedTraceFor("or-rollup-4", ["span-A", "span-B"]);
      if (parsed[0]) {
        const [g0, g1] = parsed[0].generations;
        if (g0) g0.startTime = new Date(1_700_000_000_000);
        if (g1) {
          g1.startTime = new Date(1_700_000_000_000 + 2 * 86_400_000);
          g1.requestModel = "claude-3";
        }
      }
      await storeParsedTraces(db, rawEventId, parsed);

      const rows = await selectUsageDaily();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ day: "2023-11-14", model: "gpt-4o", calls: "1" });
      expect(rows[1]).toMatchObject({ day: "2023-11-16", model: "claude-3", calls: "1" });
    });

    it("buckets null-model generations under '(unknown)' and skips null start_time", async () => {
      const db = getTestDb();
      const rawEventId = await seedRawEvent({});
      const parsed = makeParsedTraceFor("or-rollup-5", ["span-A", "span-B"]);
      if (parsed[0]) {
        const [g0, g1] = parsed[0].generations;
        if (g0) g0.startTime = null;
        if (g1) g1.requestModel = null;
      }
      await storeParsedTraces(db, rawEventId, parsed);

      const rows = await selectUsageDaily();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        model: "(unknown)",
        calls: "1",
        input_tokens: "100",
        output_tokens: "50",
        total_tokens: "150",
      });
    });
  });
});
