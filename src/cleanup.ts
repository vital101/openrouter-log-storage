import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql, type Kysely } from "kysely";
import { createDb } from "./db.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { Database } from "./types.js";

const BATCH_SIZE = 1000;

export async function deleteOldRawEvents(
  db: Kysely<Database>,
  retentionDays: number,
  batchSize: number = BATCH_SIZE,
): Promise<number> {
  let totalDeleted = 0;

  for (;;) {
    const result = await sql<{ count: string }>`
      WITH deleted AS (
        DELETE FROM raw_events
        WHERE id IN (
          SELECT id FROM raw_events
          WHERE processing_status IN ('processed', 'failed')
          AND received_at < now() - ${retentionDays} * interval '1 day'
          LIMIT ${batchSize}
        )
        RETURNING id
      )
      SELECT count(*)::text AS count FROM deleted
    `.execute(db);

    const deleted = Number(result.rows[0]?.count ?? 0);
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }

  return totalDeleted;
}

export async function deleteOldTraces(
  db: Kysely<Database>,
  retentionDays: number,
  batchSize: number = BATCH_SIZE,
): Promise<number> {
  let totalDeleted = 0;

  for (;;) {
    const result = await sql<{ count: string }>`
      WITH deleted AS (
        DELETE FROM traces
        WHERE id IN (
          SELECT id FROM traces
          WHERE received_at < now() - ${retentionDays} * interval '1 day'
          LIMIT ${batchSize}
        )
        RETURNING id
      )
      SELECT count(*)::text AS count FROM deleted
    `.execute(db);

    const deleted = Number(result.rows[0]?.count ?? 0);
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }

  return totalDeleted;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ component: "cleanup" });
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);

  logger.info(
    {
      rawEventRetentionDays: config.RAW_EVENT_RETENTION_DAYS,
      tracesRetentionDays: config.TRACES_RETENTION_DAYS,
    },
    "cleanup started",
  );

  try {
    const rawDeleted = await deleteOldRawEvents(db, config.RAW_EVENT_RETENTION_DAYS);
    logger.info({ deleted: rawDeleted }, "raw_events cleanup complete");

    const tracesDeleted = await deleteOldTraces(db, config.TRACES_RETENTION_DAYS);
    logger.info({ deleted: tracesDeleted }, "traces cleanup complete");
  } catch (err) {
    logger.error({ err }, "cleanup failed");
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error("cleanup fatal:", err);
    process.exit(1);
  });
}
