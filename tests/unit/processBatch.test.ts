import { describe, it, expect } from "vitest";
import { computeBackoffMs, shouldFailAfter } from "../../src/worker/processBatch.js";

describe("computeBackoffMs", () => {
  it("returns baseMs for the first attempt", () => {
    expect(computeBackoffMs(1, 1000, 300000)).toBe(1000);
  });

  it("doubles for the second attempt", () => {
    expect(computeBackoffMs(2, 1000, 300000)).toBe(2000);
  });

  it("doubles for the third attempt", () => {
    expect(computeBackoffMs(3, 1000, 300000)).toBe(4000);
  });

  it("caps at maxMs", () => {
    expect(computeBackoffMs(10, 1000, 300000)).toBe(300000);
  });

  it("returns base/2 when attempt=0 (matches the formula exactly)", () => {
    // base * 2^(0-1) = base * 0.5
    expect(computeBackoffMs(0, 1000, 300000)).toBe(500);
  });

  it("honors a small maxMs", () => {
    expect(computeBackoffMs(5, 1000, 100)).toBe(100);
  });
});

describe("shouldFailAfter", () => {
  it("returns false when attemptCount < maxAttempts", () => {
    expect(shouldFailAfter(4, 5)).toBe(false);
  });

  it("returns true when attemptCount equals maxAttempts", () => {
    expect(shouldFailAfter(5, 5)).toBe(true);
  });

  it("returns true when attemptCount exceeds maxAttempts", () => {
    expect(shouldFailAfter(6, 5)).toBe(true);
  });

  it("treats maxAttempts=1 as immediate fail on first failure", () => {
    expect(shouldFailAfter(1, 1)).toBe(true);
  });
});
