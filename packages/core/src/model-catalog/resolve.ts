/**
 * resolveInstance — single resolver every capability entry (chat /
 * GenerateImage / GenerateVideo) goes through. Turns a stored ModelInstance +
 * credentials + catalog into the runtime shape: which adapter, which key (from
 * the referenced credential), which preset, which param values. text/image/
 * video all share this — only adapterKind differs ("底层一套").
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { findCatalogEntry, type CatalogEntry } from "./index.js";
import type { ModelPreset } from "./types.js";

/** An independent credential (mirrors settings.credentials[] entries). */
export interface Credential {
  id: string;
  catalogId: string;
  apiKey?: string;
  baseUrl?: string;
}

/** A stored connection instance (mirrors settings.modelConnections[] entries). */
export interface ModelInstance {
  id: string;
  catalogId: string;
  tag: "text" | "image" | "video";
  model: string;
  baseUrl?: string;
  /** Which credential supplies the key (independent entity, shareable). */
  credentialId?: string;
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
 * Resolve `inst` against the credential list (for its key) and `catalog`.
 * Returns null when the instance's catalogId resolves to no entry.
 * baseUrl precedence: connection override → credential → catalog default.
 */
export function resolveInstance(
  inst: ModelInstance,
  credentials: Credential[],
  catalog: CatalogEntry[],
): ResolvedInstance | null {
  const entry = findCatalogEntry(catalog, inst.catalogId);
  if (!entry) return null;

  const cred = inst.credentialId
    ? credentials.find((c) => c.id === inst.credentialId)
    : undefined;
  const preset = entry.modelPresets?.find((p) => p.value === inst.model);

  return {
    entry,
    adapterKind: entry.adapterKind,
    baseUrl: inst.baseUrl ?? cred?.baseUrl ?? entry.defaultBaseUrl,
    apiKey: cred?.apiKey,
    preset,
    model: inst.model,
    paramValues: inst.paramValues ?? {},
  };
}
