import type { Express } from "express";
import { pino } from "pino";
import type { Kysely } from "kysely";
import { createApp } from "../../src/server.js";
import type { Database } from "../../src/types.js";
import type { Config } from "../../src/config.js";

const DEFAULT_CONFIG: Config = {
  PORT: 3000,
  DATABASE_URL: "postgres://test",
  WEBHOOK_SECRET: "test-secret",
  WEBHOOK_SECRET_HEADER: "X-Webhook-Signature",
  LOG_LEVEL: "silent",
  WORKER_POLL_INTERVAL_MS: 5_000,
  WORKER_BATCH_SIZE: 100,
  WEBHOOK_BODY_LIMIT: "10mb",
  NODE_ENV: "test",
  MAX_PROCESSING_ATTEMPTS: 5,
  WORKER_BACKOFF_BASE_MS: 1_000,
  WORKER_BACKOFF_MAX_MS: 300_000,
};

export interface TestAppOptions {
  config?: Partial<Config>;
  db: Kysely<Database>;
}

export function createTestApp(opts: TestAppOptions): Express {
  const config: Config = { ...DEFAULT_CONFIG, ...opts.config };
  const logger = pino({ level: "silent" });
  return createApp(opts.db, config, logger);
}
