import { describe, it, expect } from "bun:test";
import {
  compose,
  errorHandler,
  HttpError,
  json,
  parseByteSize,
  readJsonBody,
  resolveClientIp,
  type Handler,
} from "../../src/http.js";

const silentLogger = { info: () => {} };

function wrap(inner: Handler): Handler {
  return compose(errorHandler(silentLogger))(inner);
}

function throwing(err: unknown): Handler {
  return () => {
    throw err;
  };
}

describe("errorHandler", () => {
  it("maps HttpError(400, invalid_json) to 400 invalid_json", async () => {
    const res = await wrap(throwing(new HttpError(400, "invalid_json")))(
      new Request("http://localhost/x"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("maps HttpError(413, payload_too_large) to 413 payload_too_large", async () => {
    const res = await wrap(throwing(new HttpError(413, "payload_too_large")))(
      new Request("http://localhost/x"),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("uses the HttpError status for custom codes (body is the code)", async () => {
    const res = await wrap(throwing(new HttpError(418, "teapot")))(
      new Request("http://localhost/x"),
    );
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot" });
  });

  it("defaults to 500 internal_error for a plain Error", async () => {
    const res = await wrap(throwing(new Error("boom")))(new Request("http://localhost/x"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("passes successful responses through unchanged", async () => {
    const res = await wrap(() => json({ ok: true }))(new Request("http://localhost/x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("parseByteSize", () => {
  it("parses bytes", () => expect(parseByteSize("10b")).toBe(10));
  it("parses kilobytes", () => expect(parseByteSize("1kb")).toBe(1024));
  it("parses megabytes", () => expect(parseByteSize("10mb")).toBe(10 * 1024 ** 2));
  it("parses gigabytes", () => expect(parseByteSize("1gb")).toBe(1024 ** 3));
  it("is case-insensitive and tolerates spaces", () =>
    expect(parseByteSize(" 2 MB ")).toBe(2 * 1024 ** 2));
  it("treats a bare number as bytes", () => expect(parseByteSize("512")).toBe(512));
  it("throws on garbage", () => expect(() => parseByteSize("ten")).toThrow());
});

describe("readJsonBody", () => {
  const LIMIT = 1024;

  function post(body: string, contentType = "application/json"): Request {
    return new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  it("parses an object body", async () => {
    expect(await readJsonBody(post('{"a":1}'), LIMIT)).toEqual({ a: 1 });
  });

  it("parses an array body", async () => {
    expect(await readJsonBody(post("[1,2,3]"), LIMIT)).toEqual([1, 2, 3]);
  });

  it("returns {} for an empty body (body-parser parity)", async () => {
    expect(await readJsonBody(post(""), LIMIT)).toEqual({});
  });

  it("returns undefined for a non-JSON content type", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(await readJsonBody(req, LIMIT)).toBeUndefined();
  });

  it("accepts application/*+json", async () => {
    const req = post('{"a":1}', "application/vnd.api+json");
    expect(await readJsonBody(req, LIMIT)).toEqual({ a: 1 });
  });

  it("raises invalid_json for malformed JSON", async () => {
    await expect(readJsonBody(post("{ not valid"), LIMIT)).rejects.toThrow(
      "invalid_json",
    );
  });

  it("rejects primitive top-level values (express strict mode)", async () => {
    for (const primitive of ['"str"', "123", "true", "null"]) {
      await expect(readJsonBody(post(primitive), LIMIT)).rejects.toThrow(
        "invalid_json",
      );
    }
  });

  it("raises payload_too_large when the body exceeds the limit", async () => {
    const big = JSON.stringify({ x: "a".repeat(2048) });
    await expect(readJsonBody(post(big), LIMIT)).rejects.toThrow(
      "payload_too_large",
    );
  });

  it("raises payload_too_large based on an oversized content-length", async () => {
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9999" },
    });
    await expect(readJsonBody(req, LIMIT)).rejects.toThrow("payload_too_large");
  });
});

describe("resolveClientIp", () => {
  it("uses the last X-Forwarded-For entry", () => {
    const req = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    });
    expect(resolveClientIp(req, "9.9.9.9")).toBe("3.3.3.3");
  });

  it("falls back to the socket IP when there is no XFF", () => {
    expect(resolveClientIp(new Request("http://localhost/x"), "9.9.9.9")).toBe(
      "9.9.9.9",
    );
  });

  it("falls back to 'unknown' when neither is available", () => {
    expect(resolveClientIp(new Request("http://localhost/x"), null)).toBe(
      "unknown",
    );
  });
});
