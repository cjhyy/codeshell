import { describe, expect, test } from "bun:test";
import { CORE_AGENT_MODULE } from "./core-module.js";
import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import { ISOLATED_TASK_PROFILE, QUICK_CHAT_RESTRICTED_PROFILE } from "../engine/run-types.js";

describe("CORE_AGENT_MODULE", () => {
  test("mirrors BUILTIN_TOOLS in order as preset-tags tools", () => {
    const tools = CORE_AGENT_MODULE.engine?.tools ?? [];
    expect(tools.map((t) => t.tool.definition.name)).toEqual(
      BUILTIN_TOOLS.map((t) => t.definition.name),
    );
    expect(tools.every((t) => t.kind === "preset-tags")).toBe(true);
  });

  test("mirrors builtin presets and declares no defaultPreset", () => {
    expect(CORE_AGENT_MODULE.engine?.presets).toEqual(Object.values(BUILTIN_AGENT_PRESETS));
    expect(CORE_AGENT_MODULE.engine?.defaultPreset).toBeUndefined();
  });

  test("carries the two core behavior profiles in engine order", () => {
    expect(CORE_AGENT_MODULE.engine?.behaviorProfiles).toEqual([
      QUICK_CHAT_RESTRICTED_PROFILE,
      ISOLATED_TASK_PROFILE,
    ]);
  });
});
