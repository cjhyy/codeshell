import { describe, test, expect } from "bun:test";
import { splitNumericParams } from "./parse-keypress.js";

// Regression: splitNumericParams mapped each ';'-segment through parseInt, so
// an empty parameter (e.g. "1;;3", common in VT sequences where an omitted
// param defaults to 0) produced NaN (review-2026-05-30).

describe("splitNumericParams", () => {
  test("parses a simple list", () => {
    expect(splitNumericParams("1;2;3")).toEqual([1, 2, 3]);
  });

  test("empty params default to 0, not NaN", () => {
    expect(splitNumericParams("1;;3")).toEqual([1, 0, 3]);
    expect(splitNumericParams(";5")).toEqual([0, 5]);
  });

  test("empty string → empty list", () => {
    expect(splitNumericParams("")).toEqual([]);
  });
});
