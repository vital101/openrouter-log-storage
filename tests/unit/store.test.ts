import { describe, it, expect } from "vitest";
import { forJsonb } from "../../src/worker/store.js";

describe("forJsonb", () => {
  it("JSON.stringifies an array", () => {
    expect(forJsonb([1, 2, 3])).toBe("[1,2,3]");
  });

  it("returns the same object reference for objects", () => {
    const obj = { a: 1, b: [1, 2] };
    expect(forJsonb(obj)).toBe(obj);
  });

  it("passes through null", () => {
    expect(forJsonb(null)).toBeNull();
  });

  it("passes through primitives", () => {
    expect(forJsonb("hello")).toBe("hello");
    expect(forJsonb(42)).toBe(42);
    expect(forJsonb(true)).toBe(true);
    expect(forJsonb(undefined)).toBeUndefined();
  });

  it("only stringifies the top-level array, not nested arrays inside objects", () => {
    const obj = { tags: ["a", "b"], name: "x" };
    expect(forJsonb(obj)).toBe(obj);
  });

  it("JSON.stringifies a nested empty array", () => {
    expect(forJsonb([])).toBe("[]");
  });
});
