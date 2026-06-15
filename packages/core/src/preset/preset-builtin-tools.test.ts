import { describe, it, expect } from "bun:test";
import { BUILTIN_AGENT_PRESETS } from "./index.js";
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";

// Regression: the background-shell companions (BashOutput / KillShell /
// ListShells) were registered in BUILTIN_TOOLS and described to the model, but
// missing from every preset's builtinTools whitelist. registerBuiltins filters
// BUILTIN_TOOLS by that whitelist, so the tools were never registered — a model
// that correctly called BashOutput after Bash(run_in_background=true) hit
// "Tool not found: BashOutput" and the whole turn died with model_error.
describe("preset builtin tool whitelist", () => {
  const registeredNames = new Set(BUILTIN_TOOLS.map((t) => t.definition.name));

  it("every preset only lists tools that actually exist in BUILTIN_TOOLS", () => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const unknown = preset.builtinTools.filter((n) => !registeredNames.has(n));
      expect({ preset: preset.name, unknown }).toEqual({ preset: preset.name, unknown: [] });
    }
  });

  it("any preset offering Bash also offers its background-shell companions", () => {
    // If Bash(run_in_background=true) is available, BashOutput/KillShell/ListShells
    // must be too — otherwise the model can launch a background shell it can never
    // read, kill, or list.
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const tools = new Set(preset.builtinTools);
      if (!tools.has("Bash")) continue;
      expect({
        preset: preset.name,
        BashOutput: tools.has("BashOutput"),
        KillShell: tools.has("KillShell"),
        ListShells: tools.has("ListShells"),
      }).toEqual({ preset: preset.name, BashOutput: true, KillShell: true, ListShells: true });
    }
  });
});
