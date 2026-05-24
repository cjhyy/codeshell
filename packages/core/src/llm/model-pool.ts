/**
 * ModelPool — runtime model registry.
 *
 * Holds all available models loaded from settings. Provides:
 *   - `get(key?)` — retrieve a model config by key, or the active one
 *   - `switch(key)` — change the active model
 *   - `list()` — list all available models
 *   - `register(entry)` — add a model at runtime
 *
 * Consumers:
 *   - Engine/TurnLoop: `pool.get()` for the active model
 *   - Arena: `pool.get("sonnet")` to resolve participants by key
 *   - /model command: `pool.switch("haiku")` for hot-swap
 */

import type { LLMConfig } from "../types.js";
import { readCache } from "./model-cache.js";
import { findOpenRouterModel } from "../data/openrouter-models.js";

/**
 * Last-resort context window when neither the provider's cached
 * model list nor the OpenRouter snapshot knows the size. Picked
 * to match the most common chat-model default in 2024–2026; better
 * to truncate than to send a request the model will reject.
 */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Provider kind → OpenRouter vendor prefix. Mirrors the table in
 * model-fetcher.ts so a missing context window on a direct-provider
 * entry (e.g. OpenAI's `gpt-5.5`) can be patched from the bundled
 * OpenRouter snapshot (`openai/gpt-5.5`). Kinds outside this map
 * (groq/ollama/openrouter/custom) skip the snapshot lookup — the
 * openrouter kind is handled separately since its ids already carry
 * the vendor prefix.
 */
const OPENROUTER_VENDOR_BY_KIND: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  zai: "z-ai",
  xai: "x-ai",
  mistral: "mistralai",
};

// ─── Types ──────────────────────────────────────────────────────

export interface ModelEntry {
  /** Short alias: "claude", "sonnet", "haiku", "gpt", "deepseek" */
  key: string;
  /** Human-readable label. Auto-generated from model path if not provided. */
  label?: string;
  provider: string;
  /** Full model path: "anthropic/claude-opus-4-6" */
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxOutputTokens?: number;
  /** Per-model context window size. Falls back to config.maxContextTokens → 200_000. */
  maxContextTokens?: number;
  /** Optional reference into ProviderCatalog. When set, baseUrl/apiKey
   *  come from the catalog unless the entry overrides them. */
  providerKey?: string;
  /**
   * Per-model thinking override. Wins over the provider-level setting
   * (ProviderCatalog entry's `thinking`). Useful when models in the same
   * provider need different defaults — e.g. DeepSeek V4 Pro off but
   * V4 Flash on.
   */
  thinking?: "enabled" | "disabled";
}

// ─── Built-in context windows ────────────────────────────────────
// Known max input tokens for well-known model names. Used as a fallback
// when a settings entry doesn't specify maxContextTokens, so users don't
// have to hand-fill it for common models.
//
// Patterns are matched against the full `model` string (case-insensitive).
// First match wins — order from most specific to most generic.
const BUILTIN_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  // DeepSeek V4 family — 1M context (api-docs.deepseek.com)
  [/^deepseek-v4(?:-|$)/i, 1_000_000],
  [/(?:^|\/)deepseek-v4(?:-|$)/i, 1_000_000],
];

function lookupBuiltinContextWindow(model: string): number | undefined {
  for (const [re, tokens] of BUILTIN_CONTEXT_WINDOWS) {
    if (re.test(model)) return tokens;
  }
  return undefined;
}

// ─── ModelPool ───────────────────────────────────────────────────

export class ModelPool {
  private models = new Map<string, ModelEntry>();
  private activeKey: string | undefined;
  private providerCatalog: import("./provider-catalog.js").ProviderCatalog | undefined;
  private cacheDir: string | undefined;

  setProviderCatalog(cat: import("./provider-catalog.js").ProviderCatalog): void {
    this.providerCatalog = cat;
  }

  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  /**
   * For each entry that lacks an explicit maxContextTokens but has a
   * providerKey, fill it in. Lookup order:
   *   1. The provider's cached /v1/models response (most authoritative —
   *      it's what the vendor itself returned at last sync).
   *   2. The bundled OpenRouter snapshot, keyed by `<vendor>/<id>` — covers
   *      the common case where a direct-provider model (e.g. `gpt-5.5`)
   *      is also published on OpenRouter with full metadata.
   *   3. A final 200k floor so unknown models still get *some* context
   *      window rather than tripping max-token math downstream.
   *
   * Entries with an explicit maxContextTokens (set by the user in settings
   * or by a prior code path) are left alone — we never overwrite what the
   * user typed in.
   */
  reloadCachedContextWindows(): void {
    for (const [key, entry] of this.models) {
      if (entry.maxContextTokens != null) continue;
      const resolved = this.resolveContextWindow(entry);
      if (resolved != null) {
        this.models.set(key, { ...entry, maxContextTokens: resolved });
      }
    }
  }

  private resolveContextWindow(entry: ModelEntry): number | undefined {
    // 1. Per-provider /v1/models cache.
    if (this.cacheDir && entry.providerKey) {
      const file = readCache(this.cacheDir, entry.providerKey);
      const match = file?.models.find((m) => m.id === entry.model);
      if (match?.contextLength) return match.contextLength;
    }
    // 2. OpenRouter snapshot — translate the entry's provider kind to the
    //    snapshot's `<vendor>/<id>` form.
    const kind = entry.providerKey
      ? this.providerCatalog?.get(entry.providerKey)?.kind
      : undefined;
    if (kind === "openrouter") {
      const hit = findOpenRouterModel(entry.model);
      if (hit?.contextLength) return hit.contextLength;
    } else if (kind) {
      const vendor = OPENROUTER_VENDOR_BY_KIND[kind];
      if (vendor) {
        const hit = findOpenRouterModel(`${vendor}/${entry.model}`);
        if (hit?.contextLength) return hit.contextLength;
      }
    }
    // 3. Final floor — better than leaving it undefined and reading
    //    config.maxContextTokens (which may itself be unset).
    return FALLBACK_CONTEXT_WINDOW;
  }

  /**
   * Build a pool from an array of model entries.
   * The first entry (or the one matching `defaultKey`) becomes active.
   */
  constructor(entries?: ModelEntry[], defaultKey?: string) {
    if (entries) {
      for (const e of entries) {
        this.models.set(e.key, this.withBuiltinDefaults(e));
      }
    }
    if (defaultKey && this.models.has(defaultKey)) {
      this.activeKey = defaultKey;
    } else if (entries?.length) {
      this.activeKey = entries[0]!.key;
    }
  }

  /** Register a model at runtime. */
  register(entry: ModelEntry): void {
    this.models.set(entry.key, this.withBuiltinDefaults(entry));
    if (!this.activeKey) {
      this.activeKey = entry.key;
    }
  }

  /** Fill in known defaults (e.g. context window for DeepSeek V4) when the entry doesn't specify them. */
  private withBuiltinDefaults(entry: ModelEntry): ModelEntry {
    if (entry.maxContextTokens != null) return entry;
    const builtin = lookupBuiltinContextWindow(entry.model);
    if (builtin == null) return entry;
    return { ...entry, maxContextTokens: builtin };
  }

  /** Switch the active model. Throws if key not found. */
  switch(key: string): ModelEntry {
    const entry = this.models.get(key);
    if (!entry) {
      const available = [...this.models.keys()].join(", ");
      throw new Error(`Model "${key}" not found. Available: ${available}`);
    }
    this.activeKey = key;
    return entry;
  }

  /** Get a model by key. No key = active model. Returns undefined if not found. */
  get(key?: string): ModelEntry | undefined {
    if (key) return this.models.get(key);
    if (this.activeKey) return this.models.get(this.activeKey);
    return undefined;
  }

  /** Get the active model key. */
  getActiveKey(): string | undefined {
    return this.activeKey;
  }

  /** List all registered models. */
  list(): ModelEntry[] {
    return [...this.models.values()];
  }

  /** Number of registered models. */
  get size(): number {
    return this.models.size;
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return this.models.has(key);
  }

  /**
   * Build an LLMConfig for a given model entry, merging with a base config
   * (inherits apiKey, baseUrl, etc. from the base if not set on the entry).
   */
  toLLMConfig(entry: ModelEntry, base?: Partial<LLMConfig>): LLMConfig {
    const fromCat =
      entry.providerKey && this.providerCatalog
        ? this.providerCatalog.get(entry.providerKey)
        : undefined;
    // Map provider-kind → client-factory name. client-factory only registers
    // "anthropic" and "openai" (everything else is anthropic- or openai-
    // compatible), so kinds outside that pair must collapse to one of them.
    const kindToClientProvider = (kind: string | undefined): string => {
      if (!kind) return "openai";
      if (kind === "anthropic") return "anthropic";
      return "openai";
    };
    return {
      provider:
        entry.provider ||
        kindToClientProvider(fromCat?.kind) ||
        "openai",
      model: entry.model,
      apiKey: entry.apiKey ?? fromCat?.apiKey ?? base?.apiKey,
      baseUrl: entry.baseUrl ?? fromCat?.baseUrl ?? base?.baseUrl,
      temperature: base?.temperature ?? 0.3,
      maxTokens: entry.maxOutputTokens ?? base?.maxTokens ?? 8192,
      enableStreaming: base?.enableStreaming ?? true,
      // thinking precedence: model entry > provider catalog > base.
      // Model-level wins so users can hold one default for "deepseek"
      // and still override a single model (e.g. v4-pro off).
      ...(entry.thinking || fromCat?.thinking || base?.thinking
        ? { thinking: entry.thinking ?? fromCat?.thinking ?? base?.thinking }
        : {}),
      // Carry the catalog kind through so the capability layer can pick
      // per-(kind, model) request-shape rules. Defaults below cover the
      // unusual case where an entry has a provider but no providerKey
      // (legacy / arena-injected models).
      ...(fromCat?.kind ? { providerKind: fromCat.kind } : {}),
    };
  }

  /**
   * Build an LLMConfig for the active model (or a specific key),
   * merging with a base config.
   */
  resolveLLMConfig(key?: string, base?: Partial<LLMConfig>): LLMConfig | undefined {
    const entry = this.get(key);
    if (!entry) return undefined;
    return this.toLLMConfig(entry, base);
  }
}
