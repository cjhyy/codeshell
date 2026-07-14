import { describe, it, expect } from "bun:test";
import { BUILTIN_AGENT_PRESETS } from "./index.js";
import {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_GUARDS,
  validateBuiltinToolExposures,
} from "../tool-system/builtin/index.js";
import { cronListToolDef } from "../tool-system/builtin/cron-list.definition.js";
import { sleepToolDef } from "../tool-system/builtin/sleep.definition.js";

// Regression: the background-shell companions (BashOutput / KillShell /
// ListShells) were registered in BUILTIN_TOOLS and described to the model, but
// missing from every preset's builtinTools whitelist. registerBuiltins filters
// BUILTIN_TOOLS by that whitelist, so the tools were never registered — a model
// that correctly called BashOutput after Bash(run_in_background=true) hit
// "Tool not found: BashOutput" and the whole turn died with model_error.
describe("preset builtin tool whitelist", () => {
  const registeredNames = new Set(BUILTIN_TOOLS.map((t) => t.definition.name));

  it.each([sleepToolDef, cronListToolDef])(
    "$name registration consumes metadata from its definition source",
    (toolDef) => {
      const registered = BUILTIN_TOOLS.find((tool) => tool.definition.name === toolDef.name);

      expect(registered?.definition.description).toBe(toolDef.description);
      expect(registered?.definition.inputSchema).toBe(toolDef.inputSchema);
    },
  );

  it("every preset only lists tools that actually exist in BUILTIN_TOOLS", () => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const unknown = preset.builtinTools.filter((n) => !registeredNames.has(n));
      expect({ preset: preset.name, unknown }).toEqual({ preset: preset.name, unknown: [] });
    }
  });

  it("keeps the domain-neutral harness minimal and leaves product-only tools out", () => {
    const harness = new Set(BUILTIN_AGENT_PRESETS["harness-min"].builtinTools);
    const general = new Set(BUILTIN_AGENT_PRESETS.general.builtinTools);
    expect([...harness].every((name) => general.has(name))).toBe(true);
    for (const name of [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "AskUserQuestion",
      "Agent",
      "TodoWrite",
      "Skill",
      "MCPTool",
      "MemoryList",
      "Sleep",
      "Config",
    ]) {
      expect(harness.has(name)).toBe(true);
    }
    for (const name of [
      "Arena",
      "GenerateImage",
      "GenerateVideo",
      "browser_observe",
      "UseCredential",
    ]) {
      expect(harness.has(name)).toBe(false);
    }
    expect(BUILTIN_AGENT_PRESETS).not.toHaveProperty("terminal-coding");
  });

  it("keeps every derived permission rule scoped to a visible tool", () => {
    for (const preset of Object.values(BUILTIN_AGENT_PRESETS)) {
      const visible = new Set(preset.builtinTools);
      expect(preset.defaultPermissionRules.filter((rule) => !visible.has(rule.tool))).toEqual([]);
    }
  });

  it("fails loud on unknown requirements and prompt sections", () => {
    const read = BUILTIN_TOOLS.find((tool) => tool.definition.name === "Read")!;
    expect(() =>
      validateBuiltinToolExposures([
        { ...read, exposure: { presetTags: ["general"], requires: ["MissingCompanion"] } },
      ]),
    ).toThrow(/requires unknown tool/);
    expect(() =>
      validateBuiltinToolExposures([
        { ...read, exposure: { presetTags: ["general"], promptSections: ["unknown"] } },
      ]),
    ).toThrow(/unknown prompt section/);
  });

  it("every availability-gated tool is in the general preset whitelist", () => {
    // Regression (UseCredential「找不到这个工具」): a tool with a visibility
    // guard in BUILTIN_TOOL_GUARDS still has to be in the preset whitelist —
    // registerBuiltins filters by the whitelist FIRST, so a gated tool that's
    // missing from it can never appear no matter how the guard evaluates. Guard
    // = "hide when not applicable", NOT "auto-add when applicable".
    const general = BUILTIN_AGENT_PRESETS.general ?? Object.values(BUILTIN_AGENT_PRESETS)[0]!;
    const whitelisted = new Set(general.builtinTools);
    const gated = [...BUILTIN_TOOL_GUARDS.keys()];
    const missing = gated.filter((name) => !whitelisted.has(name));
    expect({ preset: general.name, missing }).toEqual({ preset: general.name, missing: [] });
  });

  it("the general preset offers EditModelCatalog (AI 加模型入口)", () => {
    // Regression (用户实测「找不到这个工具」第三次复发,同 BashOutput/UseCredential):
    // EditModelCatalog 在 BUILTIN_TOOLS 注册了,但漏进 preset 白名单 → registerBuiltins
    // 滤掉 → AI 想加 catalog 时调不到。这条钉死它在 general preset 里可见。
    const general = BUILTIN_AGENT_PRESETS.general ?? Object.values(BUILTIN_AGENT_PRESETS)[0]!;
    expect(general.builtinTools).toContain("EditModelCatalog");
  });

  it("the general preset offers AddMarketplace for adding plugin sources", () => {
    const general = BUILTIN_AGENT_PRESETS.general ?? Object.values(BUILTIN_AGENT_PRESETS)[0]!;
    expect(general.builtinTools).toContain("AddMarketplace");
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
