import { describe, test, expect } from "bun:test";
import { isWebSearchAvailable } from "./web-search.js";
import { isGenerateImageAvailable } from "./generate-image.js";
import { isGenerateVideoAvailable } from "./generate-video.js";
import { BUILTIN_TOOL_GUARDS } from "./index.js";
import { resolveBuiltinToolNames } from "../../preset/index.js";

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

  test("isGenerateVideoAvailable returns a boolean", () => {
    const r = isGenerateVideoAvailable("/nonexistent-cwd-xyz");
    expect(typeof r).toBe("boolean");
  });

  test("BUILTIN_TOOL_GUARDS maps the gated tools to predicates", () => {
    // Names match the real toolDef `name` fields:
    // webSearchToolDef.name === "WebSearch", generate{Image,Video}ToolDef.name accordingly.
    expect(BUILTIN_TOOL_GUARDS.has("WebSearch")).toBe(true);
    expect(BUILTIN_TOOL_GUARDS.has("GenerateImage")).toBe(true);
    expect(BUILTIN_TOOL_GUARDS.has("GenerateVideo")).toBe(true);
    expect(typeof BUILTIN_TOOL_GUARDS.get("WebSearch")!("/x")).toBe("boolean");
  });

  test("default preset includes GenerateVideo (regression: was missing → tool invisible)", () => {
    // GenerateVideo was registered + guarded but absent from GENERAL_BUILTIN_TOOLS,
    // so ToolRegistry never registered it and it never showed in the tools list.
    const names = resolveBuiltinToolNames();
    expect(names).toContain("GenerateImage");
    expect(names).toContain("GenerateVideo");
  });

  test("goal-control tools are hidden unless a goal is active", () => {
    const completeGoalGuard = BUILTIN_TOOL_GUARDS.get("complete_goal");
    const cancelGoalGuard = BUILTIN_TOOL_GUARDS.get("cancel_goal");

    expect(completeGoalGuard?.({ cwd: "/x", hasGoal: false })).toBe(false);
    expect(cancelGoalGuard?.({ cwd: "/x", hasGoal: false })).toBe(false);
    expect(completeGoalGuard?.({ cwd: "/x", hasGoal: true })).toBe(true);
    expect(cancelGoalGuard?.({ cwd: "/x", hasGoal: true })).toBe(true);
  });

  test("ungated tools have no guard entry (so they're always visible)", () => {
    expect(BUILTIN_TOOL_GUARDS.has("Read")).toBe(false);
  });
});
