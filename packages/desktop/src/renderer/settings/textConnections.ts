/**
 * Pure logic for the text connection panel (L6a). Building/identifying
 * ModelInstances and listing key-reuse candidates — no React, no window, so it
 * unit-tests cleanly. The panel component wires these to UI + settings IO.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3.
 */
import type { CatalogEntry } from "../../preload/types";

/** Mirror of core/settings modelConnections[] entry (renderer-side). */
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

/** Pick the catalog id when free, else suffix `-2`, `-3`, … */
export function uniqueInstanceId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Build a text instance from a template + picked model, seeding param defaults. */
export function buildTextInstance(
  entry: CatalogEntry,
  model: string | undefined,
  taken: Set<string>,
): ModelInstance {
  const chosen = model ?? entry.defaultModel ?? entry.modelPresets?.[0]?.value ?? "";
  const preset = entry.modelPresets?.find((p) => p.value === chosen);
  const paramValues: Record<string, unknown> = {};
  for (const p of preset?.params ?? []) {
    if (p.default !== undefined) paramValues[p.name] = p.default;
  }
  const inst: ModelInstance = {
    id: uniqueInstanceId(entry.id, taken),
    catalogId: entry.id,
    tag: "text",
    model: chosen,
    baseUrl: entry.defaultBaseUrl,
  };
  if (Object.keys(paramValues).length > 0) inst.paramValues = paramValues;
  return inst;
}

/**
 * Same-catalog instances that already have a key (so a new instance can reuse
 * it), excluding self. A key belongs to one provider account, so candidates are
 * scoped to the same catalogId — never cross-provider.
 */
export function reuseKeyCandidates(
  all: ModelInstance[],
  self: { id: string; catalogId: string },
): ModelInstance[] {
  return all.filter(
    (i) => i.id !== self.id && i.catalogId === self.catalogId && Boolean(i.apiKey),
  );
}
