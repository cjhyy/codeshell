import { createHash } from "node:crypto";
import type { CompositionSnapshot, ResolvedComposition } from "./types.js";

/**
 * Pure-data projection of a composition. Field construction order is the
 * canonical serialization order — computeCompositionDigest() hashes the
 * JSON directly, so never reorder fields without updating golden fixtures.
 * Unkeyed by design: the snapshot carries no secrets (design §11.2).
 */
export function toCompositionSnapshot(
  composition: Pick<ResolvedComposition, "modules" | "engine" | "protocol">,
): CompositionSnapshot {
  return {
    version: 1,
    modules: composition.modules.map((m) => ({ id: m.id, order: m.order, source: m.source })),
    tools: composition.engine.tools.map((t) => ({
      name: t.tool.definition.name,
      moduleId: t.moduleId,
      exposure: t.kind,
      presetTags: t.kind === "preset-tags" ? [...t.tool.exposure.presetTags] : [],
    })),
    presets: composition.engine.presets.map((p) => ({
      name: p.key,
      moduleId: p.moduleId,
      isDefault: p.key === composition.engine.defaultPreset,
    })),
    promptSections: composition.engine.promptSections.map((s) => ({
      name: s.key,
      moduleId: s.moduleId,
    })),
    hooks: composition.engine.hooks.map((h) => ({
      event: h.event,
      name: h.name,
      priority: h.priority,
      moduleId: h.moduleId,
    })),
    behaviorProfiles: composition.engine.behaviorProfiles.map((p) => ({
      id: p.key,
      moduleId: p.moduleId,
    })),
    queries: composition.protocol.queries.map((q) => ({ type: q.key, moduleId: q.moduleId })),
    observers: composition.protocol.observerFactories.map((o) => o.moduleId),
    runValidators: composition.protocol.runValidators.map((v) => v.moduleId),
    hiddenSessionKinds: composition.protocol.hiddenSessionKinds.map((k) => ({
      kind: k.key,
      moduleId: k.moduleId,
    })),
  };
}

export function computeCompositionDigest(snapshot: CompositionSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
