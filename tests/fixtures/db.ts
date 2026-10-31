import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import type { Database } from "../../src/types.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | undefined;

function createFsMigrationProvider(folder: string): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      const migrations: Record<string, Migration> = {};
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (![".js", ".ts", ".mjs", ".cjs"].includes(ext)) continue;
        const filePath = path.join(folder, entry.name);
        const fileUrl = pathToFileURL(filePath).href;
        const migrationName = entry.name.replace(/\.[^.]+$/, "");
        const mod = (await import(fileUrl)) as {
          default?: Migration;
          up?: Migration["up"];
          down?: Migration["down"];
        };
        if (typeof mod.default === "function") {
          migrations[migrationName] = mod.default;
        } else if (
          typeof mod.up === "function" &&
          typeof mod.down === "function"
        ) {
          migrations[migrationName] = mod as unknown as Migration;
        } else {
          throw new Error(
            `Migration ${entry.name} must export default function or up/down`,
          );
        }
      }
      return migrations;
    },
  };
}

async function init(): Promise<Kysely<Database>> {
  // Prefer an externally provided TEST_DATABASE_URL (docker-compose / shared
  // container). Otherwise start a throwaway testcontainer. Because this runs at
  // module top level (with await), it completes before any test body executes,
  // so getTestDb() can stay synchronous.
  let uri = process.env.TEST_DATABASE_URL;
  if (!uri) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("test")
      .withUsername("test")
      .withPassword("test")
      .start();
    uri = container.getConnectionUri();
    process.env.TEST_DATABASE_URL = uri;
  }

  const instance = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: uri, max: 10 }),
    }),
  });

  const migrator = new Migrator({
    db: instance,
    provider: createFsMigrationProvider(path.resolve(process.cwd(), "migrations")),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;

  return instance;
}

const db = await init();

export function getTestDb(): Kysely<Database> {
  return db;
}

export async function truncateAll(): Promise<void> {
  await db.deleteFrom("llm_generations").execute();
  await db.deleteFrom("traces").execute();
  await db.deleteFrom("raw_events").execute();
  await db.deleteFrom("usage_daily").execute();
  await db.deleteFrom("usage_hourly").execute();
}

export async function seedRawEvent(payload: unknown): Promise<number> {
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

// Best-effort container teardown on process exit. If we used an external
// TEST_DATABASE_URL there is nothing to stop.
const stopContainer = () => {
  if (container) void Promise.resolve(container.stop()).catch(() => {});
};
process.on("exit", stopContainer);
process.on("SIGINT", stopContainer);
process.on("SIGTERM", stopContainer);
