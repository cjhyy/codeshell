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
  tag: "text" | "image" | "video" | "audio";
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
  tag: "text" | "image" | "video" | "audio",
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
 * One row for the composer model dropdown, resolved from a text connection
 * instance against the catalog. `key` is the instance id — the engine's pool
 * keys text connections by `instance.id` (model-connections-pool.ts), and the
 * active selection lives in `settings.defaults.text` (engine priority #1), so
 * the picker speaks instance ids, not legacy models[] keys.
 */
export interface CatalogModelOption {
  key: string;
  label: string;
  provider: string;
  maxContextTokens?: number;
  supportsVision?: boolean;
}

/**
 * Map text `modelConnections` → picker options via the catalog. Chip text is
 * the catalog `displayName` (not the raw catalogId); label is the matching
 * preset's label, else the model id; vision/context come from the preset.
 * Instances whose catalogId doesn't resolve are dropped (stale store). Mirrors
 * the engine's modelEntriesFromConnections so the dropdown == what runs.
 */
export function catalogModelOptions(
  connections: ModelInstance[],
  catalog: CatalogEntry[],
): CatalogModelOption[] {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const out: CatalogModelOption[] = [];
  for (const inst of connections) {
    if (inst.tag !== "text") continue;
    const entry = byId.get(inst.catalogId);
    if (!entry) continue;
    const preset = entry.modelPresets?.find((p) => p.value === inst.model);
    out.push({
      key: inst.id,
      label: preset?.label ?? inst.model,
      provider: entry.displayName,
      maxContextTokens: preset?.maxContextTokens,
      supportsVision: preset?.supportsVision,
    });
  }
  return out;
}

/**
 * Credentials usable for a given catalogId. A key belongs to one provider
 * ACCOUNT (adapterKind = openai/google/fal/…), and the same account key works
 * across that provider's model types — e.g. an OpenAI key configured for a text
 * model is equally valid for `openai-transcribe` (audio). So candidates are
 * scoped to the same *adapterKind*, not the exact catalogId. Without the catalog
 * (or if either side's adapterKind is unresolvable) we fall back to the old
 * exact-catalogId match so nothing silently over-shares.
 *
 * This is why adding a voice connection used to show NO existing key even though
 * an OpenAI key was already saved: the old exact-catalogId filter never matched
 * `openai-transcribe` against a text-OpenAI credential.
 */
export function credentialCandidates(
  credentials: Credential[],
  catalogId: string,
  catalog?: CatalogEntry[],
): Credential[] {
  const kindOf = (id: string): string | undefined =>
    catalog?.find((e) => e.id === id)?.adapterKind;
  const wantKind = kindOf(catalogId);
  if (!wantKind) return credentials.filter((c) => c.catalogId === catalogId);
  return credentials.filter(
    (c) => c.catalogId === catalogId || kindOf(c.catalogId) === wantKind,
  );
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
