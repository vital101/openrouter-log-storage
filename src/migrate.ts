import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import { createDb, waitForDb } from "./db.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

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
            `Migration ${entry.name} must export default function or up/down named functions`,
          );
        }
      }

      return migrations;
    },
  };
}

async function main() {
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const migrationsFolder = path.resolve(process.cwd(), "migrations");

  await waitForDb(db).catch(() => {
    logger.warn("database not ready, will attempt migration anyway");
  });

  const provider = createFsMigrationProvider(migrationsFolder);
  const available = await provider.getMigrations();
  const availableNames = Object.keys(available);

  if (availableNames.length === 0) {
    logger.error({ folder: migrationsFolder }, "no migration files found");
    await db.destroy();
    process.exit(1);
  }

  logger.info(
    { folder: migrationsFolder, count: availableNames.length, names: availableNames },
    "scanning migrations",
  );

  const migrator = new Migrator({
    db,
    provider,
  });

  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    logger.error({ err: error }, "migrator failed");
    await db.destroy();
    process.exit(1);
  }

  if (!results || results.length === 0) {
    logger.info("database is already up to date; no migrations applied");
    await db.destroy();
    return;
  }

  for (const result of results) {
    if (result.status === "Success") {
      logger.info({ migration: result.migrationName }, "migration applied");
    } else if (result.status === "NotExecuted") {
      logger.info({ migration: result.migrationName }, "already applied");
    } else if (result.status === "Error") {
      logger.error(
        { migration: result.migrationName },
        "migration failed",
      );
    }
  }

  await db.destroy();
}

main().catch((err) => {
  logger.error({ err }, "migrator failed");
  process.exit(1);
});
