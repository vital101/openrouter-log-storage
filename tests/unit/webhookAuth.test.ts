import { describe, it, expect, vi } from "vitest";
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

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  const res = { status, json } as unknown as Response;
  return { res, status, json };
}

describe("webhookAuth", () => {
  it("returns 401 missing_auth_header when the header is absent", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq(undefined);
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "missing_auth_header" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 invalid_auth when the secret does not match", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("wrong");
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "invalid_auth" });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the secret matches", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("secret");
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("returns 401 when provided secret has different length", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = makeReq("shorter");
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "invalid_auth" });
    expect(next).not.toHaveBeenCalled();
  });

  it("treats the configured header name case-insensitively", () => {
    const middleware = webhookAuth("secret", "X-Webhook-Signature");
    const req = {
      get: (name: string) => (name === "x-webhook-signature" ? "secret" : undefined),
    } as unknown as Request;
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("uses a custom header name when configured", () => {
    const middleware = webhookAuth("k", "X-Custom-Auth");
    const req = {
      get: (name: string) => (name === "x-custom-auth" ? "k" : undefined),
    } as unknown as Request;
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts an additional secret when the primary is also valid", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("primary");
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts an additional secret when the primary does not match", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("extra");
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects when neither primary nor additional secrets match", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra"]);
    const req = makeReq("wrong");
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "invalid_auth" });
    expect(next).not.toHaveBeenCalled();
  });

  it("handles length-mismatch correctly with additional secrets", () => {
    const middleware = webhookAuth("primary", "X-Webhook-Signature", ["extra-long-secret"]);
    const req = makeReq("extra-long-secret-shorter");
    const { res, status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "invalid_auth" });
    expect(next).not.toHaveBeenCalled();
  });
});
