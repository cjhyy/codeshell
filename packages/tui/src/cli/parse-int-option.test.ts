import { describe, test, expect } from "bun:test";
import { parsePositiveInt } from "./parse-int-option.js";

// Regression: CLI used bare parseInt(opts.maxTurns)/parseInt(opts.limit) with
// no radix and no validation, so "--max-turns abc" silently became NaN
// (review-2026-05-30). parsePositiveInt validates and gives a clear error.

describe("parsePositiveInt", () => {
  test("parses a valid positive integer", () => {
    expect(parsePositiveInt("100", "--max-turns")).toBe(100);
  });

  test("uses radix 10 (no octal surprise)", () => {
    expect(parsePositiveInt("010", "--limit")).toBe(10);
  });

  test("throws a clear error on non-numeric input", () => {
    expect(() => parsePositiveInt("abc", "--max-turns")).toThrow(/--max-turns/);
  });

  test("throws on zero and negatives", () => {
    expect(() => parsePositiveInt("0", "--limit")).toThrow();
    expect(() => parsePositiveInt("-5", "--limit")).toThrow();
  });

  test("rejects trailing garbage (parseInt would accept '5abc')", () => {
    expect(() => parsePositiveInt("5abc", "--limit")).toThrow();
  });
});
