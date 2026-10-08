import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { loadConfig, type Config } from "../config.js";
import { createDb, waitForDb } from "../db.js";
import { createLogger } from "../logger.js";
import { processBatch } from "./processBatch.js";
import type { Database } from "../types.js";

export interface StartWorkerLoopOptions {
  db: Kysely<Database>;
  logger: Logger;
  config: Config;
}

export interface WorkerLoopHandle {
  tick: () => Promise<void>;
  stop: () => Promise<void>;
}

export function startWorkerLoop(opts: StartWorkerLoopOptions): WorkerLoopHandle {
  const { db, logger, config } = opts;

  let running = true;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (!running || inFlight) return;
    inFlight = true;
    try {
      const result = await processBatch({
        db,
        logger,
        batchSize: config.WORKER_BATCH_SIZE,
        maxAttempts: config.MAX_PROCESSING_ATTEMPTS,
        backoffBaseMs: config.WORKER_BACKOFF_BASE_MS,
        backoffMaxMs: config.WORKER_BACKOFF_MAX_MS,
        concurrency: config.WORKER_CONCURRENCY,
      });
      if (result.processed > 0 || result.failed > 0) {
        logger.info(result, "batch done");
      } else {
        logger.debug("no pending events");
      }
    } catch (err) {
      logger.error({ err }, "batch failed");
    } finally {
      inFlight = false;
    }
  };

  const intervalId = setInterval(() => {
    void tick();
  }, config.WORKER_POLL_INTERVAL_MS);

  const stop = async (): Promise<void> => {
    running = false;
    clearInterval(intervalId);
    while (inFlight) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return { tick, stop };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ component: "worker" });
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX, {
    onConnect: (client) => {
      void client.query("SET synchronous_commit = OFF").catch(() => {});
    },
  });

  await waitForDb(db);
  logger.info("database ready");

  const { stop } = startWorkerLoop({ db, logger, config });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutdown started");
    await stop();
    try {
      await db.destroy();
    } catch (err) {
      logger.error({ err }, "db destroy error");
    }
    logger.info("worker shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info(
    {
      intervalMs: config.WORKER_POLL_INTERVAL_MS,
      batchSize: config.WORKER_BATCH_SIZE,
    },
    "worker started",
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error("worker fatal:", err);
    process.exit(1);
  });
}