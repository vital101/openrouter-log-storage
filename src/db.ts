import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./types.js";

import { sql } from "kysely";

export function createDb(databaseUrl: string, poolMax: number = 10): Kysely<Database> {
  const dialect = new PostgresDialect({
    pool: new Pool({
      connectionString: databaseUrl,
      max: poolMax,
    }),
  });

  return new Kysely<Database>({ dialect });
}

export async function waitForDb(
  db: Kysely<Database>,
  options: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const { retries = 30, delayMs = 1000 } = options;
  for (let i = 0; i < retries; i++) {
    try {
      await sql`SELECT 1`.execute(db);
      return;
    } catch {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error("Database did not become ready");
}