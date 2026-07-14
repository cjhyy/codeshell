import { describe, expect, it } from "bun:test";
import { resolveBuiltinToolNames } from "@cjhyy/code-shell-core";
import {
  CODING_CAPABILITY,
  CODING_GENERAL_PRESET,
  CODING_TOOLS,
  TERMINAL_CODING_PRESET,
} from "./index.js";

describe("coding capability presets", () => {
  it("derives every contributed preset tool from coding tool metadata", () => {
    for (const [tag, preset] of [
      ["general", CODING_GENERAL_PRESET],
      ["terminal-coding", TERMINAL_CODING_PRESET],
    ] as const) {
      const contributed = CODING_TOOLS.filter((tool) => tool.exposure.presetTags.includes(tag)).map(
        (tool) => tool.definition.name,
      );
      expect(contributed.every((name) => preset.builtinTools.includes(name))).toBe(true);
    }
  });

  it("keeps external agent tools in the composed general profile", () => {
    expect(CODING_GENERAL_PRESET.builtinTools).toContain("DriveAgent");
    expect(CODING_GENERAL_PRESET.builtinTools).toContain("DriveAgentJobs");
    expect(CODING_GENERAL_PRESET.builtinTools).toContain("DriveClaudeCode");
    expect(CODING_GENERAL_PRESET.builtinTools).not.toContain("ScheduleRoomTask");
  });

  it("desktop composition swaps terminal worktree tools for its scoped bridge", () => {
    const tools = resolveBuiltinToolNames({
      preset: "terminal-coding",
      host: "desktop",
      capabilities: [CODING_CAPABILITY],
    });
    expect(tools).toContain("SwitchSessionWorkspace");
    expect(tools).not.toContain("EnterWorktree");
    expect(tools).not.toContain("ExitWorktree");
  });

  it("non-desktop composition keeps terminal worktree tools", () => {
    const tools = resolveBuiltinToolNames({
      preset: "terminal-coding",
      capabilities: [CODING_CAPABILITY],
    });
    expect(tools).toContain("EnterWorktree");
    expect(tools).toContain("ExitWorktree");
    expect(tools).not.toContain("SwitchSessionWorkspace");
  });
});
