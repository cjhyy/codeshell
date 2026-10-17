import { describe, expect, it } from "bun:test";
import {
  ALL_DIMENSIONS,
  buildReviewPrompt,
  parseDimensions,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/coding/src/review/review-prompt.ts";

describe("round19 actual review prompt leaf, owned ordinary strings", () => {
  it("characterizes mixed dimensions shown by TUI help: perf is silently dropped", () => {
    const dimensions = parseDimensions("security,perf");
    const prompt = buildReviewPrompt({ content: "-before\n+after", dimensions });
    expect(dimensions).toEqual(["security"]);
    expect(prompt).toContain("安全");
    expect(prompt).not.toContain("性能");
    const control = buildReviewPrompt({
      content: "-before\n+after",
      dimensions: parseDimensions("security,performance"),
    });
    expect(control).toContain("安全");
    expect(control).toContain("性能");
  });

  it("characterizes perf alone broadening to all dimensions; canonical name remains scoped", () => {
    const dropped = parseDimensions("perf");
    expect(dropped).toEqual(ALL_DIMENSIONS);
    const allPrompt = buildReviewPrompt({ content: "-before\n+after", dimensions: dropped, json: true });
    expect(allPrompt).toContain('"dimension": "correctness"|"security"|"performance"|"readability"');
    const canonical = parseDimensions("performance");
    expect(canonical).toEqual(["performance"]);
    const scopedPrompt = buildReviewPrompt({ content: "-before\n+after", dimensions: canonical });
    expect(scopedPrompt).toContain("性能");
    expect(scopedPrompt).not.toContain("正确性");
  });

  it("normalizes ordinary case, separators, duplicates, and unknown names", () => {
    expect(parseDimensions("  Performance, SECURITY performance unknown ")).toEqual([
      "security",
      "performance",
    ]);
    expect(parseDimensions(" , \t ")).toEqual(ALL_DIMENSIONS);
  });

  it("does not mutate caller-owned options or dimension arrays", () => {
    const dimensions = ["security", "performance"] as const;
    const options = Object.freeze({
      content: "const value = 1;",
      dimensions: Object.freeze([...dimensions]),
      incremental: false,
      json: true,
      label: "src/value.ts",
      maxChars: 100,
    });
    const before = JSON.stringify(options);
    const prompt = buildReviewPrompt(options as unknown as Parameters<typeof buildReviewPrompt>[0]);
    expect(JSON.stringify(options)).toBe(before);
    expect(prompt).toContain(options.content);
  });

  it("honors the documented default length boundary with an explicit marker only above it", () => {
    const atBoundary = "a".repeat(12_000);
    const exact = buildReviewPrompt({ content: atBoundary });
    expect(exact.endsWith("```diff\n" + atBoundary + "\n```")).toBe(true);
    expect(exact).not.toContain("…(truncated)…");
    const above = buildReviewPrompt({ content: atBoundary + "Z" });
    expect(above.endsWith("```diff\n" + atBoundary + "\n…(truncated)…\n```")).toBe(true);
    expect(above).not.toContain("Z");
  });

  it("defaults an empty dimension list and preserves ordinary labels in both output modes", () => {
    for (const json of [false, true]) {
      const prompt = buildReviewPrompt({
        content: "const value = 1;",
        dimensions: [],
        incremental: false,
        json,
        label: "src/value.ts",
      });
      expect(prompt).toContain("Review the following code for `src/value.ts`");
      expect(prompt).toContain("性能");
      expect(prompt.endsWith("```\nconst value = 1;\n```")).toBe(true);
    }
  });
});
