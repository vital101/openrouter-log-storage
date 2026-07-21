import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import type { Request, Response, NextFunction } from "express";

function makeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  return { res: { status, json } as unknown as Response, status, json };
}

describe("errorHandler", () => {
  it("maps entity.parse.failed to 400 invalid_json", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("bad json"), { type: "entity.parse.failed" }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "invalid_json" });
  });

  it("maps status 413 to 413 payload_too_large", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("too big"), { status: 413 }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: "payload_too_large" });
  });

  it("maps entity.too.large type to 413 payload_too_large", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("too big"), { type: "entity.too.large" }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: "payload_too_large" });
  });

  it("uses err.status for custom status codes (default body internal_error)", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("teapot"), { status: 418 }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(418);
    expect(json).toHaveBeenCalledWith({ error: "internal_error" });
  });

  it("defaults to 500 internal_error for a plain Error", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      new Error("boom"),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "internal_error" });
  });
});
