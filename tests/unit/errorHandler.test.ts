import { describe, it, expect, mock } from "bun:test";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import type { Request, Response, NextFunction } from "express";

function makeRes() {
  const res = { status: mock(), json: mock() };
  // res.status(x).json(y) chain: status returns the res object
  res.status.mockReturnValue(res);
  return { res: res as unknown as Response, status: res.status, json: res.json };
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
    expect(status.mock.calls[0]?.[0]).toBe(400);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "invalid_json" });
  });

  it("maps status 413 to 413 payload_too_large", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("too big"), { status: 413 }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status.mock.calls[0]?.[0]).toBe(413);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "payload_too_large" });
  });

  it("maps entity.too.large type to 413 payload_too_large", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("too big"), { type: "entity.too.large" }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status.mock.calls[0]?.[0]).toBe(413);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "payload_too_large" });
  });

  it("uses err.status for custom status codes (default body internal_error)", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      Object.assign(new Error("teapot"), { status: 418 }),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status.mock.calls[0]?.[0]).toBe(418);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "internal_error" });
  });

  it("defaults to 500 internal_error for a plain Error", () => {
    const { res, status, json } = makeRes();
    errorHandler(
      new Error("boom"),
      {} as Request,
      res,
      {} as NextFunction,
    );
    expect(status.mock.calls[0]?.[0]).toBe(500);
    expect(json.mock.calls[0]?.[0]).toEqual({ error: "internal_error" });
  });
});
