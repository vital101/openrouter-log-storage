import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createLogger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { webhookRouter } from "./routes/webhook.js";
import { webhookAuth } from "./middleware/webhookAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL);

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: config.WEBHOOK_BODY_LIMIT }));

  app.use(healthRouter(db));
  app.use(
    webhookAuth(config.WEBHOOK_SECRET, config.WEBHOOK_SECRET_HEADER),
    webhookRouter(db, config.WEBHOOK_SECRET_HEADER),
  );

  app.use(errorHandler);

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

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});