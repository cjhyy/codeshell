/**
 * Bridge settings.modelConnections[] (the unified instance store) into
 * ModelPool entries, so the engine sends requests using the new catalog-driven
 * model selection. Pure: instances + catalog → ModelEntry[]. apiKeyRef is
 * dereferenced via resolveInstance; protocol/baseUrl/token limits come from the
 * resolved catalog entry + preset.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { resolveInstance, type ModelInstance, type Credential } from "../model-catalog/resolve.js";
import type { CatalogEntry } from "../model-catalog/index.js";
import type { ModelEntry } from "../llm/model-pool.js";
import type { ReasoningSetting } from "../llm/reasoning-setting.js";

export type { ModelInstance, Credential } from "../model-catalog/resolve.js";

/** Map a catalog entry's protocol to the ModelPool `provider` (LLM client). */
function clientProvider(entry: CatalogEntry): string {
  return entry.protocol === "anthropic-style" ? "anthropic" : "openai";
}

/**
 * Map a connection's `paramValues.reasoning` to the engine's ReasoningSetting,
 * so the new param store flows through the existing reasoning request pipeline
 * (no new request-layer plumbing). enum→effort, number→budget, boolean→on/off.
 */
function reasoningFromParamValues(
  paramValues: Record<string, unknown> | undefined,
): ReasoningSetting | undefined {
  const v = paramValues?.reasoning;
  if (typeof v === "string") {
    return { mode: "effort", effort: v as Extract<ReasoningSetting, { mode: "effort" }>["effort"] };
  }
  if (typeof v === "number") return { mode: "budget", budgetTokens: v };
  if (typeof v === "boolean") return v ? { mode: "on" } : { mode: "off" };
  return undefined;
}

/**
 * Convert text model connections into ModelPool register entries. Non-text
 * instances and ones whose catalogId doesn't resolve are skipped.
 */
export function modelEntriesFromConnections(
  connections: ModelInstance[],
  credentials: Credential[],
  catalog: CatalogEntry[],
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const inst of connections) {
    if (inst.tag !== "text") continue;
    const resolved = resolveInstance(inst, credentials, catalog);
    if (!resolved) continue;
    const { entry, preset } = resolved;
    const reasoning = reasoningFromParamValues(inst.paramValues);
    const e: ModelEntry = {
      key: inst.id,
      provider: clientProvider(entry),
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      needsKey: resolved.needsKey,
      ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
      ...(preset?.maxContextTokens !== undefined ? { maxContextTokens: preset.maxContextTokens } : {}),
      ...(preset?.maxOutputTokens !== undefined ? { maxOutputTokens: preset.maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
    out.push(e);
  }
  return out;
}
