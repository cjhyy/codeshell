import { describe, it, expect } from "bun:test";
import { buildReviewPrompt, parseDimensions, ALL_DIMENSIONS } from "./review-prompt.js";

describe("coding parseDimensions", () => {
  it("defaults to all dimensions when empty", () => {
    expect(parseDimensions(undefined)).toEqual(ALL_DIMENSIONS);
    expect(parseDimensions("")).toEqual(ALL_DIMENSIONS);
  });
  it("parses a comma/space list and keeps canonical order", () => {
    expect(parseDimensions("security,performance")).toEqual(["security", "performance"]);
    expect(parseDimensions("readability correctness")).toEqual(["correctness", "readability"]);
  });
  it("drops unknown names, falling back to all if none valid", () => {
    expect(parseDimensions("bogus")).toEqual(ALL_DIMENSIONS);
    expect(parseDimensions("security,bogus")).toEqual(["security"]);
  });
});

describe("buildReviewPrompt", () => {
  it("includes the priority guide and the content in a diff fence", () => {
    const p = buildReviewPrompt({ content: "-a\n+b", incremental: true });
    expect(p).toContain("P0");
    expect(p).toContain("```diff");
    expect(p).toContain("-a\n+b");
  });

  it("uses a plain fence and 'code' wording for full-file (non-incremental)", () => {
    const p = buildReviewPrompt({ content: "x=1", incremental: false });
    expect(p).toContain("following code");
    expect(p).not.toContain("```diff");
  });

  it("only lists requested dimensions", () => {
    const p = buildReviewPrompt({
      content: "x",
      dimensions: ["security"],
    });
    expect(p).toContain("安全");
    expect(p).not.toContain("性能");
  });

  it("json mode asks for a JSON object and no prose", () => {
    const p = buildReviewPrompt({ content: "x", json: true });
    expect(p).toContain("ONLY a JSON object");
    expect(p).toContain('"priority"');
    expect(p).toContain('"confidence"');
    expect(p).toContain('"location"');
  });

  it("truncates overly long content", () => {
    const p = buildReviewPrompt({ content: "x".repeat(20_000), maxChars: 100 });
    expect(p).toContain("(truncated)");
    expect(p.length).toBeLessThan(1500);
  });

  it("includes the label when provided", () => {
    const p = buildReviewPrompt({ content: "x", label: "src/a.ts" });
    expect(p).toContain("src/a.ts");
  });
});
