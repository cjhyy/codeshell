/**
 * Runtime helpers over a ResolvedComposition. Preset selection and
 * validation happen HERE, at use time — not at compile time — because the
 * preset can change per session (config slice) and per settings hot reload.
 */
import type { AgentPreset } from "../preset/index.js";
import type { BuiltinTool } from "../tool-system/builtin/index.js";
import type { ExtensionTool } from "../tool-system/capability-module.js";
import type { ResolvedComposition } from "./types.js";
import { ConfigError } from "../exceptions.js";

/** Resolve a preset by name (or the composition default), failing loud. */
export function resolvePresetFromComposition(
  composition: ResolvedComposition,
  name?: string,
): AgentPreset {
  const resolvedName = name || composition.engine.defaultPreset;
  const found = composition.engine.presets.find((p) => p.key === resolvedName);
  if (found) return found.value;
  const allowed = composition.engine.presets.map((p) => p.key).join(", ");
  throw new Error(`Unknown agent preset "${resolvedName}". Available presets: ${allowed}`);
}

/** All preset-tags tools — the composed catalog in effective order. */
export function compositionToolCatalog(composition: ResolvedComposition): BuiltinTool[] {
  return composition.engine.tools.flatMap((t) => (t.kind === "preset-tags" ? [t.tool] : []));
}

/**
 * Preset-tags tools force-joined to the ACTIVE preset regardless of its name.
 * Rule: tools owned by modules that contribute no presets (pet-style catalog
 * tools) — presets snapshot their tool lists from catalogs known at module
 * authoring time, which can never include such packages. Modules that DO
 * contribute presets (core, coding) reference their tools via preset tags
 * already. Visibility stays gated by each tool's exposure.availability.
 */
export function presetInjectedTools(composition: ResolvedComposition): BuiltinTool[] {
  const presetOwners = new Set(composition.engine.presets.map((p) => p.moduleId));
  return composition.engine.tools.flatMap((t) =>
    t.kind === "preset-tags" && !presetOwners.has(t.moduleId) ? [t.tool] : [],
  );
}

/** Module-contributed named prompt sections as a plain record. */
export function compositionPromptSections(
  composition: ResolvedComposition,
): Record<string, string> {
  return Object.fromEntries(composition.engine.promptSections.map((s) => [s.key, s.value]));
}

/**
 * Register always-exposure tools on the engine-local registry fork.
 * Cross-module uniqueness is compiler-enforced; this guards collisions with
 * runtime-registered tools.
 */
export function registerAlwaysTools(
  composition: ResolvedComposition,
  registry: {
    hasTool(name: string): boolean;
    registerTool(definition: ExtensionTool["definition"], execute: ExtensionTool["execute"]): void;
  },
): void {
  for (const contribution of composition.engine.tools) {
    if (contribution.kind !== "always") continue;
    const name = contribution.tool.definition.name;
    if (registry.hasTool(name)) {
      throw new ConfigError(`Capability tool conflicts with registered tool: ${name}`, {
        duplicateCapabilityTool: name,
        capabilityId: contribution.moduleId,
      });
    }
    registry.registerTool(contribution.tool.definition, contribution.tool.execute);
  }
}

/** First non-null module instruction boundary, in module order. */
export function resolveCompositionInstructionBoundary(
  composition: ResolvedComposition,
  cwd: string,
): string | null {
  for (const boundary of composition.engine.instructionBoundaries) {
    const found = boundary.value(cwd);
    if (found) return found;
  }
  return null;
}
