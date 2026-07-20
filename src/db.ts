import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { Database } from "./types.js";

export function createDb(databaseUrl: string): Kysely<Database> {
  const dialect = new PostgresDialect({
    pool: new Pool({
      connectionString: databaseUrl,
      max: 10,
    }),
  });

  return new Kysely<Database>({ dialect });
}