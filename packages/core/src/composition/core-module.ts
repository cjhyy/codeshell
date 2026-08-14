import { BUILTIN_TOOLS } from "../tool-system/builtin/index.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import { ISOLATED_TASK_PROFILE, QUICK_CHAT_RESTRICTED_PROFILE } from "../engine/run-types.js";
import type { AgentModule } from "./types.js";

/**
 * Core's own declarations expressed as a module so one compiler handles a
 * single data path. This does NOT make core unloadable or overridable —
 * it is always module order 0 and duplicate keys against it fail loud.
 *
 * No defaultPreset here: the compiler falls back to DEFAULT_AGENT_PRESET
 * only when no product module declares one (mirrors resolveAgentPreset).
 */
export const CORE_AGENT_MODULE: AgentModule = {
  id: "core",
  engine: {
    tools: BUILTIN_TOOLS.map((tool) => ({ kind: "preset-tags" as const, tool })),
    presets: Object.values(BUILTIN_AGENT_PRESETS),
    behaviorProfiles: [QUICK_CHAT_RESTRICTED_PROFILE, ISOLATED_TASK_PROFILE],
  },
};
