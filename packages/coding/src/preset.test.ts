import { describe, expect, it } from "bun:test";
import {
  compileComposition,
  resolvePresetFromComposition,
  resolveToolNamesForPreset,
} from "@cjhyy/code-shell-core";
import { CODING_GENERAL_PRESET, CODING_TOOLS, TERMINAL_CODING_PRESET } from "./index.js";
import { createCodingModule } from "./index.js";

const composition = compileComposition({ modules: [createCodingModule()] });
const adjusters = composition.engine.toolSelectionAdjusters.map((a) => a.value);

function composedToolNames(host?: string): string[] {
  return resolveToolNamesForPreset({
    preset: resolvePresetFromComposition(composition, "terminal-coding"),
    host,
    adjusters,
  });
}

describe("coding module presets", () => {
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
    const tools = composedToolNames("desktop");
    expect(tools).toContain("SwitchSessionWorkspace");
    expect(tools).not.toContain("EnterWorktree");
    expect(tools).not.toContain("ExitWorktree");
  });

  it("non-desktop composition keeps terminal worktree tools", () => {
    const tools = composedToolNames();
    expect(tools).toContain("EnterWorktree");
    expect(tools).toContain("ExitWorktree");
    expect(tools).not.toContain("SwitchSessionWorkspace");
  });
});
