/**
 * Pure logic for the text connection panel. Connections reference a Credential
 * by id (the key lives on the credential, an independent entity) — so deleting
 * a connection never loses a key, and many connections share one key by
 * pointing at the same credential. No React, no window — unit-testable.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3.
 */
import type { CatalogEntry } from "../../preload/types";

/** An independent credential (mirror of core/settings credentials[]). */
export interface Credential {
  id: string;
  catalogId: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Mirror of core/settings modelConnections[] entry (renderer-side). */
export interface ModelInstance {
  id: string;
  catalogId: string;
  tag: "text" | "image" | "video";
  model: string;
  baseUrl?: string;
  /** Which credential supplies this connection's key. */
  credentialId?: string;
  paramValues?: Record<string, unknown>;
}

/** Pick the catalog id when free, else suffix `-2`, `-3`, … */
export function uniqueInstanceId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Build a connection from a template + picked model, seeding param defaults. */
export function buildInstance(
  entry: CatalogEntry,
  model: string | undefined,
  taken: Set<string>,
  tag: "text" | "image" | "video",
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
    tag,
    model: chosen,
  };
  if (Object.keys(paramValues).length > 0) inst.paramValues = paramValues;
  return inst;
}

/** tag=text specialization of buildInstance. */
export function buildTextInstance(
  entry: CatalogEntry,
  model: string | undefined,
  taken: Set<string>,
): ModelInstance {
  return buildInstance(entry, model, taken, "text");
}

/**
 * Credentials usable for a given catalogId. A key belongs to one provider
 * account, so candidates are scoped to the same catalogId — never cross-provider.
 */
export function credentialCandidates(credentials: Credential[], catalogId: string): Credential[] {
  return credentials.filter((c) => c.catalogId === catalogId);
}

/**
 * Label for a credential in a picker. Leads with the provider name + #id and
 * the key's last 4 chars — never a model name (a credential is not a model).
 */
export function credentialLabel(cred: Credential, displayName?: string): string {
  const name = displayName ? `${displayName} ` : "";
  const suffix = cred.apiKey && cred.apiKey.length >= 4 ? ` · key ⋯${cred.apiKey.slice(-4)}` : "";
  return `${name}#${cred.id}${suffix}`;
}
