import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Database } from "../../src/types.js";

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

describe("migrations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<Database>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("mig")
      .withUsername("mig")
      .withPassword("mig")
      .start();
    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: container.getConnectionUri(), max: 2 }),
      }),
    });
    const migrator = new Migrator({
      db,
      provider: createFsMigrationProvider(path.resolve(process.cwd(), "migrations")),
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("creates raw_events, traces, and llm_generations tables", async () => {
    const rows = await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(db);
    const names = rows.rows.map((t) => t.table_name);
    expect(names).toContain("raw_events");
    expect(names).toContain("traces");
    expect(names).toContain("llm_generations");
  });

  it("creates the unique index on traces.openrouter_trace_id", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'traces'`.execute(db);
    const uniq = rows.rows.find(
      (i) => i.indexdef.includes("openrouter_trace_id") && i.indexdef.includes("UNIQUE"),
    );
    expect(uniq).toBeDefined();
  });

  it("creates the unique index on llm_generations (trace_id, span_id)", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'llm_generations'`.execute(db);
    const uniq = rows.rows.find(
      (i) =>
        i.indexdef.includes("trace_id") &&
        i.indexdef.includes("span_id") &&
        i.indexdef.includes("UNIQUE"),
    );
    expect(uniq).toBeDefined();
  });

  it("creates the partial claim index on raw_events", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'raw_events'`.execute(db);
    const claim = rows.rows.find(
      (i) => i.indexname === "raw_events_claim_idx" && i.indexdef.includes("WHERE"),
    );
    expect(claim).toBeDefined();
  });

  it("is idempotent — re-running migrateToLatest does not error and applies no new migrations", async () => {
    const migrator = new Migrator({
      db,
      provider: createFsMigrationProvider(path.resolve(process.cwd(), "migrations")),
    });
    const { error, results } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    const applied = results?.filter((r) => r.status === "Success") ?? [];
    expect(applied).toHaveLength(0);
  });
});
