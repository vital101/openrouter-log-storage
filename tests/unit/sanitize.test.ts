import { describe, it, expect } from "vitest";
import {
  sanitizeJsonValue,
  sanitizeString,
} from "../../src/sanitize.js";

describe("sanitizeString", () => {
  it("replaces NUL characters with U+FFFD", () => {
    expect(sanitizeString("a\u0000b")).toBe("a\uFFFDb");
  });

  it("replaces a lone high surrogate", () => {
    expect(sanitizeString("a\uD800b")).toBe("a\uFFFDb");
  });

  it("replaces a lone low surrogate", () => {
    expect(sanitizeString("a\uDC00b")).toBe("a\uFFFDb");
  });

  it("preserves a valid surrogate pair", () => {
    expect(sanitizeString("a\uD83D\uDE00b")).toBe("a\uD83D\uDE00b");
  });

  it("leaves ordinary strings untouched", () => {
    expect(sanitizeString("hello\nworld")).toBe("hello\nworld");
  });
});

describe("sanitizeJsonValue", () => {
  it("sanitizes strings nested in objects and arrays", () => {
    expect(sanitizeJsonValue({ a: ["x\u0000y", { b: "\uD800" }] })).toEqual({
      a: ["x\uFFFDy", { b: "\uFFFD" }],
    });
  });

  it("sanitizes object keys", () => {
    expect(sanitizeJsonValue({ "a\u0000b": 1 })).toEqual({ "a\uFFFDb": 1 });
  });

  it("passes through numbers, booleans, and null", () => {
    expect(
      sanitizeJsonValue({ n: 1, b: true, z: null, u: undefined }),
    ).toEqual({ n: 1, b: true, z: null, u: undefined });
  });

  it("passes through non-plain objects such as Date", () => {
    const date = new Date(0);
    const result = sanitizeJsonValue({ d: date }) as { d: unknown };
    expect(result.d).toBe(date);
  });

  it("handles a top-level string", () => {
    expect(sanitizeJsonValue("a\u0000b")).toBe("a\uFFFDb");
  });

  it("does not pollute Object.prototype via __proto__ keys", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const output = sanitizeJsonValue(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(output["__proto__"]).toEqual({ polluted: true });
  });
});
