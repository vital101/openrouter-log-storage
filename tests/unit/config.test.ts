import { describe, it, expect, beforeEach, vi } from "vitest";

async function freshLoadConfig() {
  vi.resetModules();
  const mod = await import("../../src/config.js");
  return mod.loadConfig;
}

describe("loadConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("applies defaults when only required vars are set", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
    vi.stubEnv("WEBHOOK_SECRET", "secret");
    const loadConfig = await freshLoadConfig();
    const config = loadConfig();
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
    expect(config.DB_POOL_MAX).toBe(10);
    expect(config.WORKER_CONCURRENCY).toBe(1);
    expect(config.WEBHOOK_SECRETS).toBeUndefined();
    expect(config.WEBHOOK_RATE_LIMIT_PER_MIN).toBe(60);
  });

  it("throws when DATABASE_URL is missing", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("WEBHOOK_SECRET", "secret");
    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("throws when WEBHOOK_SECRET is missing", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "");
    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow(/WEBHOOK_SECRET/);
  });

  it("throws for invalid LOG_LEVEL", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("LOG_LEVEL", "verbose");
    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });

  it("accepts PORT=0 (Dokku sets PORT=0 for non-web processes)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("PORT", "0");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig().PORT).toBe(0);
  });

  it("throws for PORT=-1", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("PORT", "-1");
    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow();
  });

  it("throws for PORT=abc (non-numeric)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("PORT", "abc");
    const loadConfig = await freshLoadConfig();
    expect(() => loadConfig()).toThrow();
  });

  it("coerces PORT from string to number", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("PORT", "8080");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig().PORT).toBe(8080);
  });

  it("honors custom WEBHOOK_SECRET_HEADER", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("WEBHOOK_SECRET_HEADER", "X-Custom-Auth");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig().WEBHOOK_SECRET_HEADER).toBe("X-Custom-Auth");
  });

  it("caches the parsed config (returns same reference on second call)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    const loadConfig = await freshLoadConfig();
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it("uses a fresh cache after vi.resetModules()", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://a");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    const loadA = await freshLoadConfig();
    const a = loadA();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgres://b");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    const loadB = await freshLoadConfig();
    const b = loadB();
    expect(a).not.toBe(b);
    expect(a.DATABASE_URL).toBe("postgres://a");
    expect(b.DATABASE_URL).toBe("postgres://b");
  });

  it("accepts NODE_ENV as an optional string", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "s");
    vi.stubEnv("NODE_ENV", "production");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig().NODE_ENV).toBe("production");
  });

  it("includes a tip about .env.example when no .env file is present", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "");
    vi.stubEnv("HOME", "/nonexistent-where-no-env-can-exist");
    vi.stubEnv("PWD", "/nonexistent-where-no-env-can-exist");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-where-no-env-can-exist");
    const loadConfig = await freshLoadConfig();
    try {
      expect(() => loadConfig()).toThrow(/Tip: copy .env.example/);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("omits the tip when .env exists (loading succeeds)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("WEBHOOK_SECRET", "");
    vi.stubEnv("PWD", process.cwd());
    const loadConfig = await freshLoadConfig();
    try {
      expect(() => loadConfig()).not.toThrow(/Tip: copy .env.example/);
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Tip: copy .env.example/);
    }
  });
});
