/**
 * Runtime accessor for the OpenRouter model snapshot (model pricing / context /
 * modality metadata). Consumers: cost-tracker, model-pool, model-fetcher,
 * onboarding, and the TUI connect screen.
 *
 * The snapshot is a committed JSON file (`openrouter-models.json`), regenerated
 * manually by `scripts/sync-models.ts` (NOT run automatically during build —
 * copy-assets ships the existing file). It is `require`d ONCE at module load.
 *
 * If the file is missing at load (e.g. it was deleted, mis-gitignored, or
 * copy-assets was broken), the require falls back to an EMPTY snapshot instead
 * of throwing — the whole module would otherwise crash at import, taking down
 * everything that transitively imports it. Callers already treat an empty
 * `models: []` as "no metadata, use hardcoded defaults" (see model-fetcher's
 * static-catalog fallback), so degrading to empty is safe.
 */

import { createRequire } from "node:module";

const requireJson = createRequire(import.meta.url);

const EMPTY_SNAPSHOT: Snapshot = { fetchedAt: "", source: "", count: 0, models: [] };

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

const bundled: Snapshot = loadBundled();
let runtimeOverride: Snapshot | null = null;

/**
 * Coerce an arbitrary `require`d value into a valid Snapshot, or the empty
 * snapshot if it's malformed (missing/non-array `models`). Pure + exported so
 * the missing/corrupt-file degradation is unit-testable without touching disk.
 */
export function coerceSnapshot(raw: unknown): Snapshot {
  if (raw && typeof raw === "object" && Array.isArray((raw as Snapshot).models)) {
    return raw as Snapshot;
  }
  return EMPTY_SNAPSHOT;
}

/** require the committed snapshot once; degrade to empty (never throw) if the
 *  file is missing/corrupt so importing this module can't crash the process. */
function loadBundled(): Snapshot {
  try {
    return coerceSnapshot(requireJson("./openrouter-models.json"));
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

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
