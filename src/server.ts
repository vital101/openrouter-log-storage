import path from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { Kysely } from "kysely";
import { loadConfig, type Config } from "./config.js";
import { createDb, waitForDb } from "./db.js";
import { createLogger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { usageRouter } from "./routes/usage.js";
import { webhookRouter } from "./routes/webhook.js";
import { webhookAuth } from "./middleware/webhookAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { Database } from "./types.js";

export function createApp(
  db: Kysely<Database>,
  config: Config,
  logger: Logger,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: config.WEBHOOK_BODY_LIMIT }));

  app.use(healthRouter(db));
  app.use(usageRouter(db, config.TRACES_RETENTION_DAYS));

  const extraSecrets = config.WEBHOOK_SECRETS
    ? config.WEBHOOK_SECRETS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  app.use(
    webhookAuth(config.WEBHOOK_SECRET, config.WEBHOOK_SECRET_HEADER, extraSecrets),
    webhookRouter(db, config.WEBHOOK_SECRET_HEADER, config.WEBHOOK_RATE_LIMIT_PER_MIN),
  );

  app.use(errorHandler);

  return app;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);

  await waitForDb(db);
  logger.info("database ready");

  const app = createApp(db, config, logger);

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "server listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutdown started");
    server.close((err) => {
      if (err) logger.error({ err }, "server close error");
      void db
        .destroy()
        .catch((err) => logger.error({ err }, "db destroy error"))
        .finally(() => {
          logger.info("shutdown complete");
          process.exit(0);
        });
    });
    setTimeout(() => {
      logger.warn("force-exit after timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}