/**
 * CUTOVER-ONLY bridges from the legacy module interfaces to AgentModule.
 * They exist so Engine/AgentServer can run on ResolvedComposition while the
 * hosts and product packages migrate within the same PR. Deleted together
 * with CapabilityModule/ExtensionModule at the end of the cutover.
 */
import type { CapabilityModule } from "../capabilities/index.js";
import type { ExtensionModule } from "../tool-system/capability-module.js";
import type { AgentModule, ResolvedComposition } from "./types.js";
import { compileComposition } from "./compiler.js";
import { ConfigError } from "../exceptions.js";

/**
 * Resolve the Engine's composition from its config: a precompiled
 * composition wins; otherwise legacy capability/extension configs and new
 * modules are bridged through the compiler. `resolvedCapabilities` is the
 * process-global + per-engine merged list the Engine already computed.
 */
export function resolveEngineComposition(
  config: {
    composition?: ResolvedComposition;
    modules?: readonly AgentModule[];
    capabilities?: readonly CapabilityModule[];
    extensionModules?: readonly ExtensionModule[];
  },
  resolvedCapabilities: readonly CapabilityModule[],
): ResolvedComposition {
  if (config.composition && (config.modules || config.capabilities || config.extensionModules)) {
    throw new ConfigError(
      "EngineConfig.composition is mutually exclusive with modules/capabilities/extensionModules",
    );
  }
  return (
    config.composition ??
    compileComposition({
      modules: [
        ...resolvedCapabilities.map(fromCapabilityModule),
        ...(config.extensionModules ?? []).map(fromExtensionModule),
        ...(config.modules ?? []),
      ],
    })
  );
}

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

/** Resolve the AgentServer's protocol surface from its options. */
export function resolveServerProtocol(options: {
  composition?: ResolvedComposition;
  extensionModules?: readonly ExtensionModule[];
}): ResolvedComposition["protocol"] {
  if (options.composition && options.extensionModules) {
    throw new ConfigError(
      "AgentServerOptions.composition is mutually exclusive with extensionModules",
    );
  }
  return (
    options.composition?.protocol ??
    compileComposition({
      modules: (options.extensionModules ?? []).map(fromExtensionModule),
    }).protocol
  );
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
