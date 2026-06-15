/**
 * resolveInstance — single resolver every capability entry (chat /
 * GenerateImage / GenerateVideo) goes through. Turns a stored ModelInstance +
 * catalog into the runtime shape: which adapter, which key (apiKeyRef
 * dereferenced), which preset, which param values. text/image/video all share
 * this — only adapterKind differs ("底层一套").
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { findCatalogEntry, type CatalogEntry } from "./index.js";
import type { ModelPreset } from "./types.js";

/** A stored connection instance (mirrors settings.modelConnections[] entries). */
export interface ModelInstance {
  id: string;
  catalogId: string;
  tag: "text" | "image" | "video";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyRef?: string;
  paramValues?: Record<string, unknown>;
}

export interface ResolvedInstance {
  entry: CatalogEntry;
  adapterKind: string;
  baseUrl: string;
  apiKey?: string;
  preset?: ModelPreset;
  model: string;
  paramValues: Record<string, unknown>;
}

/**
 * Resolve `inst` against the full instance list (for apiKeyRef) and `catalog`.
 * Returns null when the instance's catalogId resolves to no entry.
 */
export function resolveInstance(
  inst: ModelInstance,
  all: ModelInstance[],
  catalog: CatalogEntry[],
): ResolvedInstance | null {
  const entry = findCatalogEntry(catalog, inst.catalogId);
  if (!entry) return null;

  const apiKey = effectiveKey(inst, all);
  const preset = entry.modelPresets?.find((p) => p.value === inst.model);

  return {
    entry,
    adapterKind: entry.adapterKind,
    baseUrl: inst.baseUrl ?? entry.defaultBaseUrl,
    apiKey,
    preset,
    model: inst.model,
    paramValues: inst.paramValues ?? {},
  };
}

/** Direct apiKey wins; otherwise borrow from the apiKeyRef target's apiKey. */
function effectiveKey(inst: ModelInstance, all: ModelInstance[]): string | undefined {
  if (inst.apiKey) return inst.apiKey;
  if (inst.apiKeyRef) {
    const ref = all.find((i) => i.id === inst.apiKeyRef);
    if (ref?.apiKey) return ref.apiKey;
  }
  return undefined;
}
