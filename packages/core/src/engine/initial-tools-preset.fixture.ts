import type { AgentModule } from "../composition/types.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";

/** A fixture owner declares the schemas needed to test unrelated runtime boundaries. */
export function initialToolsFixtureModule(names: readonly string[]): AgentModule {
  const base = BUILTIN_AGENT_PRESETS["harness-min"]!;
  return {
    id: "initial-tools-fixture",
    engine: {
      defaultPreset: "initial-tools-fixture",
      presets: [
        {
          ...base,
          name: "initial-tools-fixture",
          initialToolNames: [...base.initialToolNames!, ...names],
        },
      ],
    },
  };
}
