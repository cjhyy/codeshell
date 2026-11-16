/**
 * Per-Engine tool membership. An Engine's tools come from its own preset,
 * even when the host shares one runtime registry between Sessions; pooled MCP
 * tools are synced into each Engine's registry per run.
 */
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { resolveToolNamesForPreset, type AgentPreset } from "../preset/index.js";
import { presetInjectedTools } from "../composition/resolve-preset.js";
import type { ResolvedComposition } from "../composition/types.js";

/**
 * Catalog tools owned by modules that contribute no presets join every
 * preset: presets snapshot their tool lists from catalogs known at module
 * authoring time, which can never include such packages. Visibility stays
 * gated by exposure.availability. Their default permission rules join too.
 */
export function withInjectedTools(
  composition: ResolvedComposition,
  preset: AgentPreset,
): AgentPreset {
  const injected = presetInjectedTools(composition, preset.name);
  if (injected.length === 0) return preset;
  return {
    ...preset,
    builtinTools: [...preset.builtinTools, ...injected.map((tool) => tool.definition.name)],
    defaultPermissionRules: [
      ...preset.defaultPermissionRules,
      ...injected.flatMap((tool) => [...(tool.exposure.defaultPermissionRules ?? [])]),
    ],
  };
}

export interface PresetToolRegistryInput {
  composition: ResolvedComposition;
  /** The preset with injected tools already merged (see withInjectedTools). */
  preset: AgentPreset;
  toolCatalog: readonly BuiltinTool[];
  host: string | undefined;
  enabledBuiltinTools: readonly string[];
  disabledBuiltinTools: readonly string[];
}

export function presetToolNames(input: PresetToolRegistryInput): string[] {
  return resolveToolNamesForPreset({
    preset: input.preset,
    host: input.host,
    enabledBuiltinTools: [
      ...input.enabledBuiltinTools,
      ...presetInjectedTools(input.composition, input.preset.name).map(
        (tool) => tool.definition.name,
      ),
    ],
    disabledBuiltinTools: [...input.disabledBuiltinTools],
    adjusters: input.composition.engine.toolSelectionAdjusters.map((a) => a.value),
  });
}

/** A registry holding exactly this preset's builtin and catalog tools. */
export function buildPresetToolRegistry(input: PresetToolRegistryInput): ToolRegistry {
  return new ToolRegistry({
    builtinTools: presetToolNames(input),
    toolCatalog: input.toolCatalog,
  });
}
