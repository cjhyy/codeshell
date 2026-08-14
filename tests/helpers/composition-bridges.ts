/**
 * TEST-ONLY bridges from the legacy module interfaces to AgentModule.
 * Live here (not in src/) per design §12 Phase A; deleted at cutover.
 */
import type { CapabilityModule } from "../../packages/core/src/capabilities/index.js";
import type { ExtensionModule } from "../../packages/core/src/tool-system/capability-module.js";
import type { AgentModule } from "../../packages/core/src/composition/types.js";

export function fromCapabilityModule(capability: CapabilityModule): AgentModule {
  return {
    id: capability.id,
    engine: {
      tools: (capability.tools ?? []).map((tool) => ({ kind: "preset-tags" as const, tool })),
      presets: capability.presets,
      defaultPreset: capability.defaultPreset,
      promptSections: capability.promptSections,
      dynamicContextProviders: capability.dynamicContextProviders,
      instructionBoundary: capability.instructionBoundary,
      artifactDetectors: capability.artifactDetectors,
      fileHistory: capability.fileHistory,
      sessionWorkspace: capability.sessionWorkspace,
      hooks: capability.engineHooks,
      adjustToolSelection: capability.adjustToolSelection?.bind(capability),
      createToolService: capability.createToolService?.bind(capability),
    },
  };
}

export function fromExtensionModule(module: ExtensionModule): AgentModule {
  return {
    id: module.id,
    engine: {
      tools: [
        ...(module.catalogTools ?? []).map((tool) => ({ kind: "preset-tags" as const, tool })),
        ...(module.tools ?? []).map((tool) => ({ kind: "always" as const, tool })),
      ],
      behaviorProfiles: module.behaviorProfiles,
    },
    protocol: {
      queries: module.queries,
      createObserver: module.createProtocolObserver,
      validateRunParams: module.validateRunParams,
      hiddenSessionKinds: module.hiddenSessionKinds,
    },
  };
}
