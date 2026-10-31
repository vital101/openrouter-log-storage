import { describe, it, expect } from "bun:test";
import { parseEnv, loadConfig } from "../../src/config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost/test",
  WEBHOOK_SECRET: "secret",
};

function env(overrides: Record<string, string | undefined> = {}) {
  return { ...BASE_ENV, ...overrides };
}

describe("parseEnv", () => {
  it("applies defaults when only required vars are set", () => {
    const config = parseEnv(env());
    expect(config.PORT).toBe(3000);
    expect(config.WEBHOOK_SECRET_HEADER).toBe("X-Webhook-Signature");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(config.WORKER_BATCH_SIZE).toBe(100);
    expect(config.WEBHOOK_BODY_LIMIT).toBe("10mb");
    expect(config.MAX_PROCESSING_ATTEMPTS).toBe(5);
    expect(config.WORKER_BACKOFF_BASE_MS).toBe(1000);
    expect(config.WORKER_BACKOFF_MAX_MS).toBe(300000);
    expect(config.RAW_EVENT_RETENTION_DAYS).toBe(7);
    expect(config.TRACES_RETENTION_DAYS).toBe(30);
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.WORKER_CONCURRENCY).toBe(1);
    expect(config.WEBHOOK_SECRETS).toBeUndefined();
    expect(config.WEBHOOK_RATE_LIMIT_PER_MIN).toBe(60);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => parseEnv(env({ DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
  });

  it("throws when WEBHOOK_SECRET is missing", () => {
    expect(() => parseEnv(env({ WEBHOOK_SECRET: "" }))).toThrow(/WEBHOOK_SECRET/);
  });

  it("throws for invalid LOG_LEVEL", () => {
    expect(() => parseEnv(env({ LOG_LEVEL: "verbose" }))).toThrow(/LOG_LEVEL/);
  });

  it("accepts PORT=0 (Dokku sets PORT=0 for non-web processes)", () => {
    expect(parseEnv(env({ PORT: "0" })).PORT).toBe(0);
  });

  it("throws for PORT=-1", () => {
    expect(() => parseEnv(env({ PORT: "-1" }))).toThrow();
  });

  it("throws for PORT=abc (non-numeric)", () => {
    expect(() => parseEnv(env({ PORT: "abc" }))).toThrow();
  });

  it("coerces PORT from string to number", () => {
    expect(parseEnv(env({ PORT: "8080" })).PORT).toBe(8080);
  });

  it("honors custom WEBHOOK_SECRET_HEADER", () => {
    expect(
      parseEnv(env({ WEBHOOK_SECRET_HEADER: "X-Custom-Auth" })).WEBHOOK_SECRET_HEADER,
    ).toBe("X-Custom-Auth");
  });

  it("accepts NODE_ENV as an optional string", () => {
    expect(parseEnv(env({ NODE_ENV: "production" })).NODE_ENV).toBe("production");
  });

  it("includes a tip about .env.example when no .env file is present", () => {
    expect(() => parseEnv({ DATABASE_URL: "postgres://x" }, false)).toThrow(
      /Tip: copy .env.example/,
    );
  });

  it("omits the tip when .env exists (envLoaded=true)", () => {
    try {
      parseEnv({ DATABASE_URL: "postgres://x" }, true);
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Tip: copy .env.example/);
    }
  });
});

describe("loadConfig", () => {
  it("caches the parsed config (returns same reference on second call)", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });
});
