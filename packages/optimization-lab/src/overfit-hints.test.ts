import { describe, expect, test } from "bun:test";
import { overfitHints } from "./overfit-hints.js";

describe("development overfit hints", () => {
  test("Chinese source fragments, numbers and filenames are visible and deterministic", () => {
    const source = "星海项目的专项预算为73519元，依据budget.csv核对。";
    const candidate = "遵循通用流程。星海项目的专项预算为73519元，依据budget.csv核对。";
    const hints = overfitHints("遵循通用流程。", candidate, [source]);
    expect(hints.some((hint) => hint.includes("星海项目"))).toBe(true);
    expect(hints.some((hint) => hint.includes("73519"))).toBe(true);
    expect(hints.some((hint) => hint.includes("budget.csv"))).toBe(true);
    expect(overfitHints("遵循通用流程。", candidate, [source])).toEqual(hints);
  });
  test("original instructions and task objective are not treated as new examples", () => {
    const original = "Use report.csv and 2026.";
    const objective = "Always cite ProjectAlpha.";
    expect(
      overfitHints(original, `${original} ${objective}`, [original, objective], objective),
    ).toEqual([]);
  });
  test("advisory output remains bounded for large repeated inputs", () => {
    const text = Array.from(
      { length: 300 },
      (_, i) => `Project${i} file${i}.csv ${100000 + i}`,
    ).join(" ");
    const hints = overfitHints("General instructions.", text, [text]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(32);
    expect(hints.every((hint) => hint.length < 200)).toBe(true);
  });
});
