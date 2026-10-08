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

  it("returns an HTML page with per-model per-day totals", async () => {
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
    expect(res.text).toContain("model-a");
    expect(res.text).toContain("model-b");
    expect(res.text).toContain("110");
    expect(res.text).toContain("55");
    expect(res.text).toContain("1,000");
    expect(res.text).toContain("$0.1234");
    expect(res.text).toContain("3");
  });

  it("excludes buckets outside the 30-day window", async () => {
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

  it("groups by day and orders by day desc, calls desc", async () => {
    await seedUsageDaily({ day: daysAgo(2), model: "model-x", calls: 1 });
    await seedUsageDaily({ day: daysAgo(1), model: "model-x", calls: 2 });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    const day2 = daysAgo(2);
    const day1 = daysAgo(1);
    const idxDay2 = res.text.indexOf(day2);
    const idxDay1 = res.text.indexOf(day1);
    expect(idxDay1).toBeGreaterThan(-1);
    expect(idxDay2).toBeGreaterThan(-1);
    expect(idxDay1).toBeLessThan(idxDay2);
  });

  it("orders same-day rows by calls desc", async () => {
    const day1 = daysAgo(1);
    await seedUsageDaily({ day: day1, model: "model-low", calls: 1 });
    await seedUsageDaily({ day: day1, model: "model-high", calls: 9 });

    const app = createTestApp({ db: getTestDb() });
    const res = await request(app).get("/usage");

    expect(res.text.indexOf("model-high")).toBeLessThan(
      res.text.indexOf("model-low"),
    );
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
