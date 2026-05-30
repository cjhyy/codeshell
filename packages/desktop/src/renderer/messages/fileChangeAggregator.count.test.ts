import { describe, test, expect } from "bun:test";
import { countLines } from "./fileChangeAggregator.js";

// Regression: countLines did `s.split("\n").length`, counting a trailing
// newline as an extra (empty) line — inconsistent with linesOf(), which strips
// one trailing newline first (review-2026-05-30). They must agree so
// added/removed counts are correct.

describe("countLines matches linesOf semantics", () => {
  test("no trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  test("single trailing newline does not add a phantom line", () => {
    expect(countLines("a\nb\n")).toBe(2);
  });

  test("single line", () => {
    expect(countLines("a")).toBe(1);
  });

  test("empty / non-string → 0", () => {
    expect(countLines("")).toBe(0);
    expect(countLines(undefined)).toBe(0);
    expect(countLines(42)).toBe(0);
  });
});
