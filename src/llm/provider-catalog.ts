/**
 * In-memory catalog of provider credentials. Mirrors settings.providers[]
 * but offers a small API for add/update/remove that validates uniqueness
 * and (for remove) refuses to delete a provider still referenced by a
 * model entry. The caller persists changes back to settings.
 */

import type { ProviderKindName } from "./provider-kinds.js";

export interface ProviderConfig {
  key: string;
  label?: string;
  kind: ProviderKindName;
  baseUrl: string;
  apiKey?: string;
  protocol?: "openai-compat" | "anthropic-style";
  modelsPath?: string;
}

export class ProviderCatalog {
  private byKey = new Map<string, ProviderConfig>();

  constructor(entries?: ProviderConfig[]) {
    for (const e of entries ?? []) this.byKey.set(e.key, e);
  }

  list(): ProviderConfig[] {
    return [...this.byKey.values()];
  }

  get(key: string): ProviderConfig | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  add(entry: ProviderConfig): void {
    if (this.byKey.has(entry.key)) {
      throw new Error(`duplicate provider key: ${entry.key}`);
    }
    this.byKey.set(entry.key, entry);
  }

  update(key: string, patch: Partial<ProviderConfig>): void {
    const cur = this.byKey.get(key);
    if (!cur) throw new Error(`no such provider: ${key}`);
    this.byKey.set(key, { ...cur, ...patch, key: cur.key });
  }

  remove(key: string, opts: { referencedBy: string[] }): void {
    if (opts.referencedBy.length) {
      throw new Error(
        `provider ${key} still referenced by models: ${opts.referencedBy.join(", ")}`,
      );
    }
    this.byKey.delete(key);
  }

  /** Compute an unused key for a new provider, given a desired base. */
  deriveKey(base: string): string {
    if (!this.byKey.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.byKey.has(candidate)) return candidate;
    }
  }
}
