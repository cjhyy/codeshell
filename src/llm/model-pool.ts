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
}

// ─── ModelPool ───────────────────────────────────────────────────

export class ModelPool {
  private models = new Map<string, ModelEntry>();
  private activeKey: string | undefined;

  /**
   * Build a pool from an array of model entries.
   * The first entry (or the one matching `defaultKey`) becomes active.
   */
  constructor(entries?: ModelEntry[], defaultKey?: string) {
    if (entries) {
      for (const e of entries) {
        this.models.set(e.key, e);
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
    this.models.set(entry.key, entry);
    if (!this.activeKey) {
      this.activeKey = entry.key;
    }
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
    return {
      provider: entry.provider,
      model: entry.model,
      apiKey: entry.apiKey ?? base?.apiKey,
      baseUrl: entry.baseUrl ?? base?.baseUrl,
      temperature: base?.temperature ?? 0.3,
      maxTokens: entry.maxOutputTokens ?? base?.maxTokens ?? 8192,
      enableStreaming: base?.enableStreaming ?? true,
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
