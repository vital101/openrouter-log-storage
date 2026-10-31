import { describe, it, expect, mock } from "bun:test";
import { webhookAuth } from "../../src/middleware/webhookAuth.js";
import type { Request, Response, NextFunction } from "express";

function makeReq(headerValue: string | undefined): Request {
  return {
    get: (name: string) => {
      if (!headerValue) return undefined;
      return name === "x-webhook-signature" ? headerValue : undefined;
    },
  } as unknown as Request;
}

type MockFn = { mock: { calls: unknown[][] } };

function makeRes(): { res: Response; status: MockFn; json: MockFn } {
  const res = { status: mock(), json: mock() };
  res.status.mockReturnValue(res);
  return { res: res as unknown as Response, status: res.status, json: res.json };
}

/** Returns both the Express-typed next and the underlying mock for assertions. */
function makeNext(): { next: NextFunction; nextMock: MockFn } {
  const nextMock = mock(() => {});
  return { next: nextMock as unknown as NextFunction, nextMock };
}

describe("webhookAuth", () => {
  it("returns 401 missing_auth_header when the header is absent", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq(undefined);
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(status.mock.calls[0]?.[0]).toBe(401);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "missing_auth_header" });
    expect(nextMock.mock.calls.length).toBe(0);
  });

  it("returns 401 invalid_auth when the secret does not match", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("wrong");
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(status.mock.calls[0]?.[0]).toBe(401);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "invalid_auth" });
    expect(nextMock.mock.calls.length).toBe(0);
  });

  it("calls next() when the secret matches", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("secret");
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(nextMock.mock.calls.length).toBe(1);
    expect(status.mock.calls.length).toBe(0);
    expect(json.mock.calls.length).toBe(0);
  });

  it("returns 401 when provided secret has different length", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("shorter");
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(status.mock.calls[0]?.[0]).toBe(401);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "invalid_auth" });
    expect(nextMock.mock.calls.length).toBe(0);
  });

  it("treats the configured header name case-insensitively", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = {
      get: (name: string) => (name === "x-webhook-signature" ? "secret" : undefined),
    } as unknown as Request;
    const { res } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(nextMock.mock.calls.length).toBe(1);
  });

  it("uses a custom header name when configured", () => {
    const middleware = webhookAuth("k", "X-Custom-Auth");
    const req = {
      get: (name: string) => (name === "x-custom-auth" ? "k" : undefined),
    } as unknown as Request;
    const { res } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(nextMock.mock.calls.length).toBe(1);
  });

  it("accepts an additional secret when the primary is also valid", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("primary");
    const { res } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(nextMock.mock.calls.length).toBe(1);
  });

  it("accepts an additional secret when the primary does not match", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("extra");
    const { res } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(nextMock.mock.calls.length).toBe(1);
  });

  it("rejects when neither primary nor additional secrets match", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("wrong");
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(status.mock.calls[0]?.[0]).toBe(401);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "invalid_auth" });
    expect(nextMock.mock.calls.length).toBe(0);
  });

  it("handles length-mismatch correctly with additional secrets", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra-long-secret"]);
    const req = makeReq("extra-long-secret-shorter");
    const { res, status, json } = makeRes();
    const { next, nextMock } = makeNext();

    middleware(req, res, next);

    expect(status.mock.calls[0]?.[0]).toBe(401);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "invalid_auth" });
    expect(nextMock.mock.calls.length).toBe(0);
  });
});
