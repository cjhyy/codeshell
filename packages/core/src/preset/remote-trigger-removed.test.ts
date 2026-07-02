import { describe, test, expect } from "bun:test";
import { BUILTIN_AGENT_PRESETS } from "./index.js";
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";

/**
 * RemoteTrigger is a dead tool: it writes a pending JSON to
 * ~/.code-shell/triggers and reports success, but nothing anywhere consumes
 * that directory, so the task never runs. It must not be visible to the model
 * — schedule/loop work goes through CronCreate + DriveAgent instead. Removed
 * from both the preset whitelist and the builtin registry.
 */
describe("RemoteTrigger removed", () => {
  test("not in any built-in agent preset whitelist", () => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      expect(preset.builtinTools).not.toContain("RemoteTrigger");
    }
  });

  test("not registered in BUILTIN_TOOLS", () => {
    const names = BUILTIN_TOOLS.map((t) => t.definition.name);
    expect(names).not.toContain("RemoteTrigger");
  });
});
