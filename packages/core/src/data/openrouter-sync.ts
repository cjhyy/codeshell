/**
 * Runtime sync of the OpenRouter model catalog.
 *
 * Fetches openrouter.ai/api/v1/models and replaces the bundled snapshot
 * in memory for the rest of the process. Used by the /sync-models slash
 * command. To persist a sync across restarts, re-run the build (which
 * re-runs scripts/sync-models.ts).
 */

import {
  type OpenRouterModel,
  setOpenRouterSnapshot,
  getOpenRouterSnapshot,
} from "./openrouter-models.js";

const ENDPOINT = "https://openrouter.ai/api/v1/models";

interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
}

function priceToPerMillion(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function slim(m: RawModel): OpenRouterModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    created: m.created ?? 0,
    contextLength: m.top_provider?.context_length ?? m.context_length ?? 0,
    maxOutputTokens: m.top_provider?.max_completion_tokens ?? 0,
    inputPricePerMillion: priceToPerMillion(m.pricing?.prompt),
    outputPricePerMillion: priceToPerMillion(m.pricing?.completion),
    modalities: m.architecture?.input_modalities ?? [],
  };
}

export interface SyncResult {
  ok: boolean;
  count: number;
  error?: string;
}

export async function syncOpenRouterCatalog(timeoutMs = 15_000): Promise<SyncResult> {
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, count: 0, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const payload = (await res.json()) as { data?: RawModel[] };
    const raw = payload.data ?? [];
    const models = raw.map(slim).sort((a, b) => b.created - a.created);
    setOpenRouterSnapshot({
      fetchedAt: new Date().toISOString(),
      source: ENDPOINT,
      count: models.length,
      models,
    });
    return { ok: true, count: models.length };
  } catch (err) {
    return { ok: false, count: 0, error: (err as Error).message };
  }
}

export { getOpenRouterSnapshot };
