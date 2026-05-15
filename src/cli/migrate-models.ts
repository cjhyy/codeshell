/**
 * One-shot migration of legacy flat models[] into providers[] + models[].
 *
 * Pure function — takes a snapshot, returns the new snapshot plus a flag.
 * The caller (settings load path) is responsible for writing settings.json
 * and the .bak backup.
 */

import type { ProviderConfig } from "../llm/provider-catalog.js";
import type { ProviderKindName } from "../llm/provider-kinds.js";

interface LegacyModel {
  key: string;
  label?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  providerKey?: string;
}

export interface MigrationInput {
  providers: ProviderConfig[];
  models: LegacyModel[];
}

export interface MigrationOutput {
  providers: ProviderConfig[];
  models: Array<{
    key: string;
    label?: string;
    providerKey: string;
    model: string;
    /**
     * Self-describing legacy fields. Kept (rather than stripped) so model
     * entries stay valid standalone — the engine can read credentials
     * straight off the entry without a ProviderCatalog round-trip.
     */
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    maxOutputTokens?: number;
    maxContextTokens?: number;
  }>;
  changed: boolean;
}

const BASEURL_KIND_PATTERNS: Array<[RegExp, ProviderKindName]> = [
  [/deepseek\.com/i, "deepseek"],
  [/z\.ai/i, "zai"],
  [/anthropic\.com/i, "anthropic"],
  [/openai\.com/i, "openai"],
  [/x\.ai/i, "xai"],
  [/mistral\.ai/i, "mistral"],
  [/groq\.com/i, "groq"],
  [/generativelanguage\.googleapis/i, "google"],
  [/openrouter\.ai/i, "openrouter"],
  [/localhost:11434|127\.0\.0\.1:11434/i, "ollama"],
];

function inferKind(baseUrl: string | undefined): ProviderKindName {
  if (!baseUrl) return "custom";
  for (const [re, kind] of BASEURL_KIND_PATTERNS) {
    if (re.test(baseUrl)) return kind;
  }
  return "custom";
}

function makeFingerprint(m: LegacyModel): string {
  return `${m.provider ?? ""}|${m.baseUrl ?? ""}|${m.apiKey ?? ""}`;
}

function deriveKey(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Generate `<provider>-<model-id>` style pool key. Mirrors the
 * `deriveModelPoolKey` helper in onboarding.ts — kept inline here to avoid
 * an import cycle (settings/manager.ts → migrate-models.ts → ...).
 */
function deriveProviderModelKey(providerKind: string, modelId: string, used: Set<string>): string {
  const slash = modelId.lastIndexOf("/");
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const prefix = providerKind.toLowerCase();
  const candidate = base.toLowerCase().startsWith(`${prefix}-`) ? base : `${prefix}-${base}`;
  if (!used.has(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const k = `${candidate}-${i}`;
    if (!used.has(k)) return k;
  }
}

export function migrateModels(input: MigrationInput): MigrationOutput {
  if (input.models.length === 0) {
    return {
      providers: input.providers,
      models: [],
      changed: false,
    };
  }

  const hasProvidersSection = input.providers.length > 0;
  // Per-entry check (replaces the old "providers non-empty → skip everything"
  // shortcut, which left legacy entries from the previous run forever
  // un-migrated and bleeding key collisions like the two "deepseek" entries
  // that motivated this rewrite).
  //   - Needs migration if: no providerKey set, OR
  //   - Needs migration if: the entry's `key` collides with a sibling (the
  //     old modelKey() helper folded v4-flash + v4-pro to "deepseek").
  const keyCounts = new Map<string, number>();
  for (const m of input.models) keyCounts.set(m.key, (keyCounts.get(m.key) ?? 0) + 1);

  const needsMigration = input.models.some(
    (m) => !m.providerKey || (keyCounts.get(m.key) ?? 0) > 1,
  );

  if (!needsMigration) {
    return {
      providers: input.providers,
      models: input.models.map((m) => ({
        key: m.key,
        label: m.label,
        providerKey: m.providerKey ?? "",
        model: m.model,
        maxOutputTokens: m.maxOutputTokens,
        maxContextTokens: m.maxContextTokens,
        provider: (m as LegacyModel & { provider?: string }).provider,
        baseUrl: m.baseUrl,
        apiKey: m.apiKey,
      })),
      changed: false,
    };
  }

  // Build providerKey map from fingerprint (provider|baseUrl|apiKey). Each
  // unique fingerprint becomes one provider entry. Existing providers[] are
  // preserved; new ones are appended.
  const fingerprintToKey = new Map<string, string>();
  const newProviders: ProviderConfig[] = [];
  const usedProviderKeys = new Set<string>(input.providers.map((p) => p.key));

  // Pre-seed: if existing providers[] match a model's fingerprint already,
  // reuse them instead of minting a new key.
  for (const p of input.providers) {
    const fp = `${""}|${p.baseUrl}|${p.apiKey ?? ""}`;
    fingerprintToKey.set(fp, p.key);
  }

  for (const m of input.models) {
    const fp = makeFingerprint(m);
    // Also try matching against existing providers by baseUrl only — the
    // legacy "provider" field on models is a generic kind ("openai") that
    // doesn't disambiguate, so the fingerprint above won't match if the
    // user added the provider via the wizard but kept legacy model entries.
    const existingByUrl = input.providers.find((p) => p.baseUrl === (m.baseUrl ?? ""));
    if (existingByUrl) {
      fingerprintToKey.set(fp, existingByUrl.key);
      continue;
    }
    if (fingerprintToKey.has(fp)) continue;
    const kind = inferKind(m.baseUrl);
    const key = deriveKey(kind, usedProviderKeys);
    usedProviderKeys.add(key);
    fingerprintToKey.set(fp, key);
    newProviders.push({
      key,
      kind,
      baseUrl: m.baseUrl ?? "",
      apiKey: m.apiKey,
    });
  }

  // Re-key models: any entry whose key collides with a sibling gets a fresh
  // `<provider>-<model-id>` key. Entries that already have a unique key are
  // left alone so user-customized aliases survive migration.
  const usedModelKeys = new Set<string>();
  const newModels = input.models.map((m) => {
    const providerKey = fingerprintToKey.get(makeFingerprint(m))!;
    const collides = (keyCounts.get(m.key) ?? 0) > 1;
    let key = m.key;
    if (collides) {
      const kind = inferKind(m.baseUrl);
      key = deriveProviderModelKey(kind, m.model, usedModelKeys);
    }
    if (usedModelKeys.has(key)) {
      // Defensive: if the user's original key happens to collide with a
      // freshly minted one, re-derive too.
      const kind = inferKind(m.baseUrl);
      key = deriveProviderModelKey(kind, m.model, usedModelKeys);
    }
    usedModelKeys.add(key);
    return {
      key,
      label: m.label,
      providerKey,
      provider: (m as LegacyModel & { provider?: string }).provider,
      model: m.model,
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      maxOutputTokens: m.maxOutputTokens,
      maxContextTokens: m.maxContextTokens,
    };
  });

  // De-duplicate: if migration produced two entries with the same key + model
  // (e.g. legacy duplicate that re-keys to the same canonical form), keep
  // only the first.
  const seen = new Set<string>();
  const deduped = newModels.filter((m) => {
    const fp = `${m.key}|${m.model}`;
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });

  return {
    providers: hasProvidersSection ? [...input.providers, ...newProviders] : newProviders,
    models: deduped,
    changed: true,
  };
}
