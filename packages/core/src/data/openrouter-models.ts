/**
 * Runtime accessor for the OpenRouter model snapshot.
 *
 * The snapshot is generated at build time by `scripts/sync-models.ts`
 * from https://openrouter.ai/api/v1/models. Reading happens lazily on
 * first call, so the JSON is parsed at most once per process.
 *
 * If the snapshot is missing or empty (e.g. first checkout before a
 * build, or sync failure with no prior file), accessors return [] and
 * callers should fall back to hardcoded defaults.
 */

import snapshotJson from "./openrouter-models.json";

export interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modalities: string[];
}

interface Snapshot {
  fetchedAt: string;
  source: string;
  count: number;
  models: OpenRouterModel[];
}

const bundled: Snapshot = snapshotJson as Snapshot;
let runtimeOverride: Snapshot | null = null;

function loadSnapshot(): Snapshot {
  return runtimeOverride ?? bundled;
}

/** Replace the in-memory snapshot for the rest of this process. */
export function setOpenRouterSnapshot(next: Snapshot): void {
  runtimeOverride = next;
}

export function getOpenRouterSnapshot(): Snapshot {
  return loadSnapshot();
}

export function getOpenRouterModels(): OpenRouterModel[] {
  return loadSnapshot().models;
}

export function findOpenRouterModel(id: string): OpenRouterModel | undefined {
  return loadSnapshot().models.find((m) => m.id === id);
}

/** Models filtered by vendor prefix, e.g. "anthropic", "openai", "deepseek". */
export function listOpenRouterModelsByVendor(vendor: string): OpenRouterModel[] {
  const prefix = `${vendor.toLowerCase()}/`;
  return loadSnapshot().models.filter((m) => m.id.toLowerCase().startsWith(prefix));
}
