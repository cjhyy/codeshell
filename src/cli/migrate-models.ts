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
    maxOutputTokens?: number;
    maxContextTokens?: number;
  }>;
  changed: boolean;
}

const BASEURL_KIND_PATTERNS: Array<[RegExp, ProviderKindName]> = [
  [/deepseek\.com/i, "deepseek"],
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

export function migrateModels(input: MigrationInput): MigrationOutput {
  const alreadyMigrated =
    input.providers.length > 0 || input.models.every((m) => m.providerKey);
  if (alreadyMigrated || input.models.length === 0) {
    return {
      providers: input.providers,
      models: input.models.map((m) => ({
        key: m.key,
        label: m.label,
        providerKey: m.providerKey ?? "",
        model: m.model,
        maxOutputTokens: m.maxOutputTokens,
        maxContextTokens: m.maxContextTokens,
      })),
      changed: false,
    };
  }

  const fingerprintToKey = new Map<string, string>();
  const newProviders: ProviderConfig[] = [];
  const usedKeys = new Set<string>(input.providers.map((p) => p.key));

  for (const m of input.models) {
    const fp = makeFingerprint(m);
    if (fingerprintToKey.has(fp)) continue;
    const kind = inferKind(m.baseUrl);
    const key = deriveKey(kind, usedKeys);
    usedKeys.add(key);
    fingerprintToKey.set(fp, key);
    newProviders.push({
      key,
      kind,
      baseUrl: m.baseUrl ?? "",
      apiKey: m.apiKey,
    });
  }

  const newModels = input.models.map((m) => ({
    key: m.key,
    label: m.label,
    providerKey: fingerprintToKey.get(makeFingerprint(m))!,
    model: m.model,
    maxOutputTokens: m.maxOutputTokens,
    maxContextTokens: m.maxContextTokens,
  }));

  return {
    providers: [...input.providers, ...newProviders],
    models: newModels,
    changed: true,
  };
}
