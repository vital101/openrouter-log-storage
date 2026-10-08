import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "../../src/types.js";

let cached: Kysely<Database> | undefined;

export function getTestDb(): Kysely<Database> {
  if (cached) return cached;
  const uri = process.env.TEST_DATABASE_URL;
  if (!uri) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Did global-setup run?",
    );
  }
  cached = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: uri, max: 10 }),
    }),
  });
  return cached;
}

export async function truncateAll(): Promise<void> {
  const db = getTestDb();
  await db.deleteFrom("llm_generations").execute();
  await db.deleteFrom("traces").execute();
  await db.deleteFrom("raw_events").execute();
  await db.deleteFrom("usage_daily").execute();
}

export async function seedRawEvent(payload: unknown): Promise<number> {
  const db = getTestDb();
  const result = await db
    .insertInto("raw_events")
    .values({
      payload: JSON.stringify(payload),
      auth_header_name: "X-Webhook-Signature",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return Number(result.id);
}
