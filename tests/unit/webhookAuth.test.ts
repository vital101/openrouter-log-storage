import { describe, it, expect, mock } from "bun:test";
import { webhookAuth } from "../../src/middleware/webhookAuth.js";
import { json, type Handler } from "../../src/http.js";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/webhook/openrouter", {
    method: "POST",
    headers,
  });
}

/** Wrap the middleware around a spread that records invocation. */
function makeChain(headerName: string, secrets: string[], extraSecrets: string[] = []) {
  const next = mock(() => json({ ok: true }));
  const handler = webhookAuth(secrets[0] ?? "", headerName, extraSecrets)(
    next as unknown as Handler,
  );
  return { handler, next };
}

describe("webhookAuth", () => {
  it("returns 401 missing_auth_header when the header is absent", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["secret"]);
    const res = await handler(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_auth_header" });
    expect(next.mock.calls.length).toBe(0);
  });

  it("returns 401 invalid_auth when the secret does not match", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["secret"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_auth" });
    expect(next.mock.calls.length).toBe(0);
  });

  it("calls next() when the secret matches", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["secret"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "secret" }));
    expect(res.status).toBe(200);
    expect(next.mock.calls.length).toBe(1);
  });

  it("returns 401 when provided secret has different length", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["secret"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "shorter" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_auth" });
    expect(next.mock.calls.length).toBe(0);
  });

  it("treats the configured header name case-insensitively", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["secret"]);
    const res = await handler(makeRequest({ "x-webhook-signature": "secret" }));
    expect(res.status).toBe(200);
    expect(next.mock.calls.length).toBe(1);
  });

  it("uses a custom header name when configured", async () => {
    const { handler, next } = makeChain("X-Custom-Auth", ["k"]);
    const res = await handler(makeRequest({ "X-Custom-Auth": "k" }));
    expect(res.status).toBe(200);
    expect(next.mock.calls.length).toBe(1);
  });

  it("accepts an additional secret when the primary is also valid", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["primary"], ["extra"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "primary" }));
    expect(res.status).toBe(200);
    expect(next.mock.calls.length).toBe(1);
  });

  it("accepts an additional secret when the primary does not match", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["primary"], ["extra"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "extra" }));
    expect(res.status).toBe(200);
    expect(next.mock.calls.length).toBe(1);
  });

  it("rejects when neither primary nor additional secrets match", async () => {
    const { handler, next } = makeChain("X-Webhook-Signature", ["primary"], ["extra"]);
    const res = await handler(makeRequest({ "X-Webhook-Signature": "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_auth" });
    expect(next.mock.calls.length).toBe(0);
  });

  it("handles length-mismatch correctly with additional secrets", async () => {
    const { handler, next } = makeChain(
      "X-Webhook-Signature",
      ["primary"],
      ["extra-long-secret"],
    );
    const res = await handler(
      makeRequest({ "X-Webhook-Signature": "extra-long-secret-shorter" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_auth" });
    expect(next.mock.calls.length).toBe(0);
  });
});
