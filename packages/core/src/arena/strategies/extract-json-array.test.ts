import { describe, test, expect } from "bun:test";
import { extractJSONArray } from "./utils.js";

// Regression: extractJSONArray used a greedy /\[[\s\S]*\]/ that spanned from
// the first '[' to the LAST ']', merging two arrays (or array + trailing
// prose containing ']') into one invalid blob (review-2026-05-30). It should
// return the first balanced top-level array.

describe("extractJSONArray", () => {
  test("extracts a single array", () => {
    expect(extractJSONArray('here: [1, 2, 3] done')).toBe("[1, 2, 3]");
  });

  test("returns only the FIRST array when two are present", () => {
    expect(extractJSONArray('[1,2] and then [3,4]')).toBe("[1,2]");
  });

  test("handles nested arrays (balanced, not smallest)", () => {
    expect(extractJSONArray('x [[1,2],[3,4]] y')).toBe("[[1,2],[3,4]]");
  });

  test("respects ] inside strings", () => {
    expect(extractJSONArray('["a]b", "c"]')).toBe('["a]b", "c"]');
  });

  test("prefers a fenced ```json block", () => {
    expect(extractJSONArray("```json\n[1,2]\n```")).toBe("[1,2]");
  });

  test("falls back to the original text when no array is present", () => {
    expect(extractJSONArray("no arrays here")).toBe("no arrays here");
  });
});
