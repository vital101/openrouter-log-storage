import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { createTestApp } from "../fixtures/app.js";
import type { Database } from "../../src/types.js";

async function seedGeneration(
  traceId: string,
  opts: {
    requestModel?: string;
    startTime: Date;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    totalCost?: number;
  },
): Promise<void> {
  const db = getTestDb();
  await db
    .insertInto("llm_generations")
    .values({
      trace_id: traceId,
      span_id: `span-${opts.startTime.getTime()}-${Math.random()}`,
      start_time: opts.startTime,
      request_model: opts.requestModel ?? "model-a",
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cached_tokens: opts.cachedTokens ?? 0,
      reasoning_tokens: opts.reasoningTokens ?? 0,
      total_tokens:
        (opts.inputTokens ?? 0) +
        (opts.outputTokens ?? 0) +
        (opts.cachedTokens ?? 0) +
        (opts.reasoningTokens ?? 0),
      total_cost: opts.totalCost ?? 0,
    })
    .execute();
}

async function seedTrace(id: string): Promise<string> {
  const db = getTestDb();
  const result = await db
    .insertInto("traces")
    .values({ openrouter_trace_id: id })
    .returning("id")
    .executeTakeFirstOrThrow();
  return result.id;
}

const OLD_DATE = new Date("2020-01-01T00:00:00Z");

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

describe("GET /usage", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns an HTML page with per-model per-day totals", async () => {
    const db = getTestDb();
    const traceId = await seedTrace("usage-trace-1");
    const day1 = daysAgo(1);
    await seedGeneration(traceId, {
      requestModel: "model-a",
      startTime: day1,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 25,
      reasoningTokens: 5,
      totalCost: 0.1234,
    });
    await seedGeneration(traceId, {
      requestModel: "model-a",
      startTime: day1,
      inputTokens: 10,
      outputTokens: 5,
    });
    await seedGeneration(traceId, {
      requestModel: "model-b",
      startTime: day1,
      inputTokens: 1000,
      outputTokens: 500,
    });

    const app = createTestApp({ db });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("style-src 'unsafe-inline'");
    expect(res.text).toContain("OpenRouter Usage");
    expect(res.text).toContain("model-a");
    expect(res.text).toContain("model-b");
    expect(res.text).toContain("110");
    expect(res.text).toContain("55");
    expect(res.text).toContain("1,000");
    expect(res.text).toContain("$0.1234");
  });

  it("excludes generations outside the 30-day window", async () => {
    const db = getTestDb();
    const traceId = await seedTrace("usage-trace-2");
    await seedGeneration(traceId, {
      requestModel: "ancient-model",
      startTime: OLD_DATE,
      inputTokens: 9999,
    });

    const app = createTestApp({ db });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("ancient-model");
    expect(res.text).not.toContain("9999");
  });

  it("groups by day and orders by day desc, calls desc", async () => {
    const db = getTestDb();
    const traceId = await seedTrace("usage-trace-3");
    await seedGeneration(traceId, { requestModel: "model-x", startTime: daysAgo(2) });
    await seedGeneration(traceId, { requestModel: "model-x", startTime: daysAgo(1) });
    await seedGeneration(traceId, { requestModel: "model-x", startTime: daysAgo(1) });

    const app = createTestApp({ db });
    const res = await request(app).get("/usage");

    const day2 = daysAgo(2).toISOString().slice(0, 10);
    const day1 = daysAgo(1).toISOString().slice(0, 10);
    const idxDay2 = res.text.indexOf(day2);
    const idxDay1 = res.text.indexOf(day1);
    expect(idxDay1).toBeGreaterThan(-1);
    expect(idxDay2).toBeGreaterThan(-1);
    expect(idxDay1).toBeLessThan(idxDay2);
  });

  it("handles an empty table", async () => {
    const db = getTestDb();
    const app = createTestApp({ db });
    const res = await request(app).get("/usage");
    expect(res.status).toBe(200);
    expect(res.text).toContain("OpenRouter Usage");
    expect(res.text).toContain("$0.0000");
  });

  it("escapes HTML in model names", async () => {
    const db = getTestDb();
    const traceId = await seedTrace("usage-trace-4");
    await seedGeneration(traceId, {
      requestModel: "<script>alert(1)</script>",
      startTime: daysAgo(1),
    });

    const app = createTestApp({ db });
    const res = await request(app).get("/usage");

    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("returns 500 when the database is unreachable", async () => {
    const badDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString:
            "postgres://nope:nope@127.0.0.1:1/nope?connectionTimeoutMillis=500",
          max: 1,
        }),
      }),
    });
    const app = createTestApp({ db: badDb });
    const res = await request(app).get("/usage");
    expect(res.status).toBe(500);
    expect(res.text).toContain("Error");
    await badDb.destroy();
  });
});
