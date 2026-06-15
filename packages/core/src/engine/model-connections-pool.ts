/**
 * Bridge settings.modelConnections[] (the unified instance store) into
 * ModelPool entries, so the engine sends requests using the new catalog-driven
 * model selection. Pure: instances + catalog → ModelEntry[]. apiKeyRef is
 * dereferenced via resolveInstance; protocol/baseUrl/token limits come from the
 * resolved catalog entry + preset.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { resolveInstance, type ModelInstance } from "../model-catalog/resolve.js";
import type { CatalogEntry } from "../model-catalog/index.js";
import type { ModelEntry } from "../llm/model-pool.js";

export type { ModelInstance } from "../model-catalog/resolve.js";

/** Map a catalog entry's protocol to the ModelPool `provider` (LLM client). */
function clientProvider(entry: CatalogEntry): string {
  return entry.protocol === "anthropic-style" ? "anthropic" : "openai";
}

/**
 * Convert text model connections into ModelPool register entries. Non-text
 * instances and ones whose catalogId doesn't resolve are skipped.
 */
export function modelEntriesFromConnections(
  connections: ModelInstance[],
  catalog: CatalogEntry[],
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const inst of connections) {
    if (inst.tag !== "text") continue;
    const resolved = resolveInstance(inst, connections, catalog);
    if (!resolved) continue;
    const { entry, preset } = resolved;
    const e: ModelEntry = {
      key: inst.id,
      provider: clientProvider(entry),
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
      ...(preset?.maxContextTokens !== undefined ? { maxContextTokens: preset.maxContextTokens } : {}),
      ...(preset?.maxOutputTokens !== undefined ? { maxOutputTokens: preset.maxOutputTokens } : {}),
    };
    out.push(e);
  }
  return out;
}
