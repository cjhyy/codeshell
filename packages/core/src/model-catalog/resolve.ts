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
  tag: "text" | "image" | "video" | "audio";
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
  /** Whether the catalog template requires a key (false = local/no-auth provider).
   *  Surfaced so higher layers can tell "needs a key but has none" (a misconfig
   *  worth a clear error) from "legitimately keyless". resolveInstance itself
   *  still NEVER throws on a missing key — that no-crash contract is unchanged. */
  needsKey: boolean;
  preset?: ModelPreset;
  model: string;
  paramValues: Record<string, unknown>;
}

function endpointOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A credential may be shared by multiple catalog entries only when they refer
 * to the same provider family AND endpoint origin. This preserves intentional
 * sharing such as OpenAI text ↔ OpenAI Images/Transcribe while preventing an
 * OpenAI account from being attached to an OpenRouter template merely because
 * both speak the OpenAI-compatible protocol.
 *
 * An exact catalogId match remains authoritative: a credential can carry an
 * explicit provider-specific baseUrl override for that catalog entry.
 */
export function isCredentialCompatible(
  entry: CatalogEntry,
  credential: Credential,
  catalog: CatalogEntry[],
  connectionBaseUrl?: string,
): boolean {
  if (credential.catalogId === entry.id) return true;
  const credentialEntry = findCatalogEntry(catalog, credential.catalogId);
  if (!credentialEntry || credentialEntry.adapterKind !== entry.adapterKind) return false;
  const connectionOrigin = endpointOrigin(connectionBaseUrl ?? entry.defaultBaseUrl);
  const credentialOrigin = endpointOrigin(credential.baseUrl ?? credentialEntry.defaultBaseUrl);
  return Boolean(connectionOrigin && credentialOrigin && connectionOrigin === credentialOrigin);
}

/**
 * Resolve `inst` against the credential list (for its key) and `catalog`.
 * Returns null when the instance's catalogId resolves to no entry or an
 * explicitly referenced credential belongs to a different provider/endpoint.
 * baseUrl precedence: connection override → credential → catalog default.
 */
export function resolveInstance(
  inst: ModelInstance,
  credentials: Credential[],
  catalog: CatalogEntry[],
): ResolvedInstance | null {
  const entry = findCatalogEntry(catalog, inst.catalogId);
  if (!entry) return null;

  const candidate = inst.credentialId
    ? credentials.find((c) => c.id === inst.credentialId)
    : undefined;
  if (candidate && !isCredentialCompatible(entry, candidate, catalog, inst.baseUrl)) {
    return null;
  }
  const cred = candidate;
  const preset = entry.modelPresets?.find((p) => p.value === inst.model);

  return {
    entry,
    adapterKind: entry.adapterKind,
    baseUrl: inst.baseUrl ?? cred?.baseUrl ?? entry.defaultBaseUrl,
    apiKey: cred?.apiKey,
    needsKey: entry.needsKey !== false, // default-true: only an explicit false is keyless
    preset,
    model: inst.model,
    paramValues: inst.paramValues ?? {},
  };
}
