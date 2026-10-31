import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { Server } from "bun";

type HttpServer = Server<undefined>;
import { createTestApp } from "../fixtures/app.js";
import { getTestDb, truncateAll } from "../fixtures/db.js";
import { maxRequestBodySizeFor, SERVE_IDLE_TIMEOUT_SECONDS } from "../../src/server.js";
import type { Config } from "../../src/config.js";

const SECRET = "socket-secret";
const HEADER = "X-Webhook-Signature";

const CONFIG: Config = {
  PORT: 0,
  DATABASE_URL: "postgres://test",
  WEBHOOK_SECRET: SECRET,
  WEBHOOK_SECRET_HEADER: HEADER,
  LOG_LEVEL: "silent",
  WORKER_POLL_INTERVAL_MS: 60_000,
  WORKER_BATCH_SIZE: 100,
  WEBHOOK_BODY_LIMIT: "64kb",
  NODE_ENV: "test",
  MAX_PROCESSING_ATTEMPTS: 5,
  WORKER_BACKOFF_BASE_MS: 1_000,
  WORKER_BACKOFF_MAX_MS: 300_000,
  RAW_EVENT_RETENTION_DAYS: 7,
  TRACES_RETENTION_DAYS: 30,
  DB_POOL_MAX: 10,
  WORKER_CONCURRENCY: 1,
  WEBHOOK_SECRETS: undefined,
  WEBHOOK_RATE_LIMIT_PER_MIN: 0,
};

let server: HttpServer | undefined;

function startServer(): { url: string; server: HttpServer } {
  const app = createTestApp({ db: getTestDb(), config: CONFIG });
  const instance = Bun.serve<undefined>({
    port: 0,
    idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: maxRequestBodySizeFor(CONFIG),
    fetch: (request) => app(request, "127.0.0.1"),
  });
  server = instance;
  return { url: `http://127.0.0.1:${instance.port}`, server: instance };
}

afterAll(async () => {
  await server?.stop();
});

describe("Bun.serve integration", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("serves /healthz over a real socket", async () => {
    const { url } = startServer();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("applies helmet-equivalent security headers over a real socket", async () => {
    const { url } = startServer();
    const res = await fetch(`${url}/healthz`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("ingests a webhook over a real socket", async () => {
    const { url } = startServer();
    const res = await fetch(`${url}/webhook/openrouter`, {
      method: "POST",
      headers: { [HEADER]: SECRET, "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("number");
  });

  it("returns our JSON 413 (not Bun's plain-text one) above the body limit", async () => {
    const { url } = startServer();
    // Larger than WEBHOOK_BODY_LIMIT (64kb), smaller than the Bun backstop.
    const oversized = JSON.stringify({ x: "a".repeat(80_000) });
    expect(oversized.length).toBeGreaterThan(64 * 1024);
    expect(oversized.length).toBeLessThan(maxRequestBodySizeFor(CONFIG));

    const res = await fetch(`${url}/webhook/openrouter`, {
      method: "POST",
      headers: { [HEADER]: SECRET, "content-type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("returns 400 invalid_json for a malformed body over a real socket", async () => {
    const { url } = startServer();
    const res = await fetch(`${url}/webhook/openrouter`, {
      method: "POST",
      headers: { [HEADER]: SECRET, "content-type": "application/json" },
      body: "{ nope",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("stops gracefully", async () => {
    const { url, server: instance } = startServer();
    await fetch(`${url}/healthz`);
    await expect(instance.stop()).resolves.toBeUndefined();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    server = undefined;
  });
});
