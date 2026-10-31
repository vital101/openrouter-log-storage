import type { Logger } from "./logger.js";
import type { Kysely } from "kysely";
import { loadConfig, type Config } from "./config.js";
import { createDb, waitForDb } from "./db.js";
import { createLogger } from "./logger.js";
import { healthHandler } from "./routes/health.js";
import { usageHandler } from "./routes/usage.js";
import { webhookHandler } from "./routes/webhook.js";
import { webhookAuth } from "./middleware/webhookAuth.js";
import {
  compose,
  errorHandler,
  parseByteSize,
  rateLimit,
  requestLogger,
  router,
  securityHeaders,
  type Handler,
} from "./http.js";
import type { Database } from "./types.js";

const TEST_CONNECTION_HEADER = "x-test-connection";
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Bun's default idleTimeout is 10s, which would cut off slow large uploads. */
export const SERVE_IDLE_TIMEOUT_SECONDS = 60;
/** Extra headroom so readJsonBody's JSON 413 wins over Bun's plain-text one. */
const MAX_BODY_BACKSTOP_SLACK_BYTES = 1_000_000;

export function maxRequestBodySizeFor(config: Config): number {
  return parseByteSize(config.WEBHOOK_BODY_LIMIT) + MAX_BODY_BACKSTOP_SLACK_BYTES;
}

/**
 * Build the request handler. No socket is bound here, so tests can call it
 * directly with a `Request`. `main()` wraps this in `Bun.serve`.
 */
export function createApp(
  db: Kysely<Database>,
  config: Config,
  logger: Logger,
): Handler {
  const extraSecrets = config.WEBHOOK_SECRETS
    ? config.WEBHOOK_SECRETS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const webhook = compose(
    webhookAuth(config.WEBHOOK_SECRET, config.WEBHOOK_SECRET_HEADER, extraSecrets),
    ...(config.WEBHOOK_RATE_LIMIT_PER_MIN > 0
      ? [
          rateLimit({
            windowMs: RATE_LIMIT_WINDOW_MS,
            max: config.WEBHOOK_RATE_LIMIT_PER_MIN,
            skip: (req) =>
              req.headers.get(TEST_CONNECTION_HEADER)?.toLowerCase() === "true",
          }),
        ]
      : []),
  )(
    webhookHandler({
      db,
      authHeaderName: config.WEBHOOK_SECRET_HEADER,
      bodyLimitBytes: parseByteSize(config.WEBHOOK_BODY_LIMIT),
    }),
  );

  const dispatch = router([
    { method: "GET", path: "/healthz", handler: healthHandler(db) },
    {
      method: "GET",
      path: "/usage",
      handler: usageHandler(db, config.TRACES_RETENTION_DAYS),
    },
    { method: "POST", path: "/webhook/openrouter", handler: webhook },
  ]);

  return compose(
    securityHeaders(),
    requestLogger(logger),
    errorHandler(logger),
  )(dispatch);
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);

  await waitForDb(db);
  logger.info("database ready");

  const app = createApp(db, config, logger);

  const server = Bun.serve({
    port: config.PORT,
    idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
    // Backstop only: readJsonBody enforces WEBHOOK_BODY_LIMIT and returns the
    // JSON payload_too_large error before Bun's limit can trigger.
    maxRequestBodySize: maxRequestBodySizeFor(config),
    fetch(request, srv) {
      return app(request, srv.requestIP(request)?.address ?? null);
    },
    error(err) {
      logger.error({ err }, "server error");
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    },
  });

  logger.info({ port: server.port }, "server listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown started");
    setTimeout(() => {
      logger.warn("force-exit after timeout");
      process.exit(1);
    }, 10_000).unref();

    try {
      // Graceful: stop accepting new connections, wait for in-flight requests.
      await server.stop();
    } catch (err) {
      logger.error({ err }, "server close error");
    }

    try {
      await db.destroy();
    } catch (err) {
      logger.error({ err }, "db destroy error");
    }

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
