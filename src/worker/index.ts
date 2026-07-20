import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createLogger } from "../logger.js";
import { processBatch } from "./processBatch.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ component: "worker" });
  const db = createDb(config.DATABASE_URL);

  let running = true;
  let inFlight = false;

  const tick = async () => {
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

  const intervalId = setInterval(tick, config.WORKER_POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutdown started");
    running = false;
    clearInterval(intervalId);
    while (inFlight) {
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      await db.destroy();
    } catch (err) {
      logger.error({ err }, "db destroy error");
    }
    logger.info("worker shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info(
    {
      intervalMs: config.WORKER_POLL_INTERVAL_MS,
      batchSize: config.WORKER_BATCH_SIZE,
    },
    "worker started",
  );
}

main().catch((err) => {
  console.error("worker fatal:", err);
  process.exit(1);
});