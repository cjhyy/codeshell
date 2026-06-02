import { describe, test, expect } from "bun:test";
import { isWebSearchAvailable } from "./web-search.js";
import { isGenerateImageAvailable } from "./generate-image.js";
import { BUILTIN_TOOL_GUARDS } from "./index.js";

describe("builtin tool availability guards", () => {
  test("isWebSearchAvailable returns a boolean for a cwd with no search config", () => {
    // A throwaway dir almost certainly has no search provider configured.
    const r = isWebSearchAvailable("/nonexistent-cwd-xyz");
    expect(typeof r).toBe("boolean");
  });

  test("isGenerateImageAvailable returns a boolean", () => {
    const r = isGenerateImageAvailable("/nonexistent-cwd-xyz");
    expect(typeof r).toBe("boolean");
  });

  test("BUILTIN_TOOL_GUARDS maps the two gated tools to predicates", () => {
    // Names match the real toolDef `name` fields (confirmed Step 0):
    // webSearchToolDef.name === "WebSearch", generateImageToolDef.name === "GenerateImage".
    expect(BUILTIN_TOOL_GUARDS.has("WebSearch")).toBe(true);
    expect(BUILTIN_TOOL_GUARDS.has("GenerateImage")).toBe(true);
    expect(typeof BUILTIN_TOOL_GUARDS.get("WebSearch")!("/x")).toBe("boolean");
  });

  test("ungated tools have no guard entry (so they're always visible)", () => {
    expect(BUILTIN_TOOL_GUARDS.has("Read")).toBe(false);
  });
});
