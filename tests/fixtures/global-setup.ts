import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import { Pool } from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "../../src/types.js";

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
        } else if (typeof mod.up === "function" && typeof mod.down === "function") {
          migrations[migrationName] = mod as unknown as Migration;
        } else {
          throw new Error(`Migration ${entry.name} must export default or up/down`);
        }
      }
      return migrations;
    },
  };
}

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername("test")
    .withPassword("test")
    .start();
  const uri = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = uri;

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: uri, max: 2 }),
    }),
  });
  const migrator = new Migrator({
    db,
    provider: createFsMigrationProvider(path.resolve(process.cwd(), "migrations")),
  });
  const { error } = await migrator.migrateToLatest();
  await db.destroy();
  if (error) throw error;
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = undefined;
  }
  delete process.env.TEST_DATABASE_URL;
}
