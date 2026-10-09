import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { createTestApp } from "../fixtures/app.js";
import type { Database } from "../../src/types.js";

async function seedUsageDaily(opts: {
  day: string;
  model: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  totalCost?: number;
  avgMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  statusCounts?: Record<string, number>;
  finishCounts?: Record<string, number>;
  providerCounts?: Record<string, number>;
  responseCounts?: Record<string, number>;
  promptChars?: number;
  completionChars?: number;
}): Promise<void> {
  const db = getTestDb();
  await db
    .insertInto("usage_daily")
    .values({
      day: opts.day,
      model: opts.model,
      calls: opts.calls ?? 1,
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cached_tokens: opts.cachedTokens ?? 0,
      reasoning_tokens: opts.reasoningTokens ?? 0,
      total_tokens: opts.totalTokens ?? 0,
      total_cost: opts.totalCost ?? 0,
      avg_duration_ms: opts.avgMs ?? null,
      p50_duration_ms: opts.p50Ms ?? null,
      p95_duration_ms: opts.p95Ms ?? null,
      status_counts: opts.statusCounts ?? null,
      finish_reason_counts: opts.finishCounts ?? null,
      provider_counts: opts.providerCounts ?? null,
      response_model_counts: opts.responseCounts ?? null,
      prompt_chars: opts.promptChars ?? null,
      completion_chars: opts.completionChars ?? null,
    })
    .execute();
}

async function seedTopCall(opts: {
  model: string;
  provider?: string;
  cost: number;
  tokens?: number;
  durationMs?: number;
  daysAgo?: number;
}): Promise<void> {
  const db = getTestDb();
  const trace = await db
    .insertInto("traces")
    .values({ openrouter_trace_id: `top-${Math.random()}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("llm_generations")
    .values({
      trace_id: trace.id,
      span_id: `span-${Math.random()}`,
      start_time: new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000),
      request_model: opts.model,
      provider_name: opts.provider ?? "openai",
      total_tokens: opts.tokens ?? 100,
      duration_ms: opts.durationMs ?? 100,
      total_cost: opts.cost,
    })
    .execute();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

describe("GET /usage", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("renders the dashboard with per-model totals", async () => {
    const day1 = daysAgo(1);
    await seedUsageDaily({
      day: day1,
      model: "model-a",
      calls: 2,
      inputTokens: 110,
      outputTokens: 55,
      cachedTokens: 25,
      reasoningTokens: 5,
      totalTokens: 195,
      totalCost: 0.1234,
      avgMs: 120,
      p50Ms: 100,
      p95Ms: 200,
      statusCounts: { "1": 2 },
      finishCounts: { stop: 2 },
      providerCounts: { openai: 2 },
      responseCounts: { "gpt-4o": 2 },
      promptChars: 400,
      completionChars: 100,
    });
    await seedUsageDaily({
      day: day1,
      model: "model-b",
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toContain("style-src 'unsafe-inline'");
    expect(res.text).toContain("OpenRouter Usage");
    expect(res.text).toContain("Total calls");
    expect(res.text).toContain("Daily trend");
    expect(res.text).toContain("Activity by hour");
    expect(res.text).toContain("Models");
    expect(res.text).toContain("Outcomes");
    expect(res.text).toContain("model-a");
    expect(res.text).toContain("model-b");
    expect(res.text).toContain("1,000");
    expect(res.text).toContain("$0.1234");
    expect(res.text).toContain("100 ms");
    expect(res.text).toContain("200 ms");
  });

  it("excludes buckets outside the window", async () => {
    await seedUsageDaily({
      day: "2020-01-01",
      model: "ancient-model",
      calls: 1,
      inputTokens: 9999,
      totalTokens: 9999,
    });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("ancient-model");
    expect(res.text).not.toContain("9999");
  });

  it("?days widens the window for historical buckets", async () => {
    await seedUsageDaily({ day: daysAgo(60), model: "old-model", calls: 1 });

    const app = createTestApp({ db: getTestDb() });

    const narrow = await request(app).get("/usage?days=30");
    expect(narrow.text).not.toContain("old-model");

    const wide = await request(app).get("/usage?days=90");
    expect(wide.text).toContain("old-model");
  });

  it("clamps ?days to 1..90 and falls back on garbage input", async () => {
    const app = createTestApp({ db: getTestDb() });

    const high = await request(app).get("/usage?days=999");
    expect(high.status).toBe(200);
    expect(high.text).toContain("last 90 days");

    const low = await request(app).get("/usage?days=0");
    expect(low.status).toBe(200);
    expect(low.text).toContain("last 1 days");

    const garbage = await request(app).get("/usage?days=abc");
    expect(garbage.status).toBe(200);
    expect(garbage.text).toContain("last 30 days");
  });

  it("sorts models by cost desc", async () => {
    const day1 = daysAgo(1);
    await seedUsageDaily({ day: day1, model: "model-low", totalCost: 1 });
    await seedUsageDaily({ day: day1, model: "model-high", totalCost: 9 });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.text.indexOf("model-high")).toBeLessThan(
      res.text.indexOf("model-low"),
    );
  });

  it("renders outcome and drift sections from mixes", async () => {
    await seedUsageDaily({
      day: daysAgo(1),
      model: "model-a",
      calls: 3,
      statusCounts: { "1": 1, "2": 1, "(none)": 1 },
      finishCounts: { stop: 1, length: 1 },
      responseCounts: { "model-a": 1, "model-a-mini": 1 },
      providerCounts: { openai: 2 },
    });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.text).toContain("Outcomes");
    expect(res.text).toContain("length");
    expect(res.text).toContain("33.3%");
    expect(res.text).toContain("Model drift");
    expect(res.text).toContain("model-a-mini");
  });

  it("renders the hourly heatmap from usage_hourly", async () => {
    const db = getTestDb();
    await db
      .insertInto("usage_hourly")
      .values({ hour: new Date(), model: "model-a", calls: 7 })
      .execute();

    const app = createTestApp({ db });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Activity by hour");
    expect(res.text).toContain("7 calls");
  });

  it("renders the most expensive calls ordered by cost", async () => {
    await seedTopCall({ model: "small-cost-model", cost: 1.5, daysAgo: 1 });
    await seedTopCall({ model: "big-cost-model", cost: 9.25, daysAgo: 1 });
    await seedTopCall({ model: "ancient-cost-model", cost: 99, daysAgo: 60 });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Most expensive calls");
    expect(res.text).toContain("big-cost-model");
    expect(res.text).toContain("$9.2500");
    expect(res.text.indexOf("big-cost-model")).toBeLessThan(
      res.text.indexOf("small-cost-model"),
    );
    expect(res.text).not.toContain("ancient-cost-model");
  });

  it("handles an empty table", async () => {
    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");
    expect(res.status).toBe(200);
    expect(res.text).toContain("OpenRouter Usage");
    expect(res.text).toContain("$0.0000");
  });

  it("escapes HTML in model names", async () => {
    await seedUsageDaily({
      day: daysAgo(1),
      model: "<script>alert(1)</script>",
      calls: 1,
    });

    const app = createTestApp({ db: getTestDb() });
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
