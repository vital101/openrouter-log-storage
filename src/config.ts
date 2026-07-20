import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  WEBHOOK_SECRET_HEADER: z.string().min(1).default("X-Webhook-Signature"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WEBHOOK_BODY_LIMIT: z.string().min(1).default("10mb"),
  NODE_ENV: z.string().optional(),
  MAX_PROCESSING_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WORKER_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  WORKER_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300000),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  let envLoaded = false;
  try {
    process.loadEnvFile(path.resolve(process.cwd(), ".env"));
    envLoaded = true;
  } catch {
    // no .env file is fine
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    const tip = envLoaded
      ? ""
      : "\n\nTip: copy .env.example to .env and set DATABASE_URL and WEBHOOK_SECRET.";
    throw new Error(`Invalid environment configuration:${tip}\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}