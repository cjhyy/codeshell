import { describe, it, expect } from "bun:test";
import { PLAN_MODE_ALLOWED_TOOLS } from "./plan-mode-allowlist.js";

/**
 * C: plan-mode allow-list was duplicated in engine.ts (what the model SEES)
 * and executor.ts (what actually RUNS), and the two lists had drifted:
 * engine listed the Task family + Bash but not TodoWrite; executor listed
 * TodoWrite but not the Task family. Result: the model could call a tool it
 * was shown (e.g. TaskCreate) only to have the executor block it, and
 * vice-versa. Both sites now share this single constant.
 */
describe("PLAN_MODE_ALLOWED_TOOLS", () => {
  it("includes the read-only core", () => {
    for (const t of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(t)).toBe(true);
    }
  });

  it("includes the planning/agent tools", () => {
    for (const t of ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "Agent", "ToolSearch"]) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(t)).toBe(true);
    }
  });

  it("includes ALL task-tracking tools (the drifted ones): TodoWrite + Task*", () => {
    for (const t of ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(t)).toBe(true);
    }
  });

  it("includes Bash (model sees it; executor gates it to read-only commands)", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Bash")).toBe(true);
  });

  it("does NOT include write/mutating tools", () => {
    for (const t of ["Write", "Edit", "ApplyPatch", "NotebookEdit"]) {
      expect(PLAN_MODE_ALLOWED_TOOLS.has(t)).toBe(false);
    }
  });
});
