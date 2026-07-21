/**
 * upsertCatalogEntry — add-or-update a CatalogEntry in the user catalog array,
 * keyed by `id`. Pure: returns a new array, input untouched. Existing id →
 * replaced in place (order preserved); new id → appended. The catalog edit tool
 * wraps this with backup + zod validate + atomic write.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §7.
 */
import type { CatalogEntry, ModelPreset } from "./types.js";

export function upsertCatalogEntry(existing: CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const idx = existing.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...existing, entry];
  const next = existing.slice();
  next[idx] = entry;
  return next;
}

/** Add or replace one model preset by its provider-scoped model id. */
export function upsertModelPreset(existing: ModelPreset[], preset: ModelPreset): ModelPreset[] {
  const idx = existing.findIndex((candidate) => candidate.value === preset.value);
  if (idx === -1) return [...existing, preset];
  const next = existing.slice();
  next[idx] = preset;
  return next;
}
