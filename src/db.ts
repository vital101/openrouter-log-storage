import { Pool, type PoolClient } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./types.js";

import { sql } from "kysely";

export interface CreateDbOptions {
  onConnect?: (client: PoolClient) => void;
}

export function createDb(
  databaseUrl: string,
  poolMax: number = 10,
  options: CreateDbOptions = {},
): Kysely<Database> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  const { onConnect } = options;
  if (onConnect) {
    pool.on("connect", (client) => {
      try {
        onConnect(client);
      } catch {
        // session tuning must never block connection creation
      }
    });
  }

  const dialect = new PostgresDialect({ pool });

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
