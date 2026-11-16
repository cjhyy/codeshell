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
  /** Published cache prices; absent in older snapshots. */
  cacheReadPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
  /** Higher prices that apply to a whole request once its prompt reaches a size. */
  priceTiers?: OpenRouterPriceTier[];
  modalities: string[];
}

export interface OpenRouterPriceTier {
  minPromptTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheReadPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
}

/** The `pricing` object of one entry in openrouter.ai/api/v1/models (USD per token). */
export interface RawOpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: Array<{
    min_prompt_tokens?: number;
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  }>;
}

function perMillion(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  // toPrecision drops float noise such as 0.09999999999999999.
  return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toPrecision(12)) : undefined;
}

/** Snapshot price fields from a raw OpenRouter pricing object. */
export function openRouterPriceFields(
  pricing: RawOpenRouterPricing | undefined,
): Pick<
  OpenRouterModel,
  | "inputPricePerMillion"
  | "outputPricePerMillion"
  | "cacheReadPricePerMillion"
  | "cacheWritePricePerMillion"
  | "priceTiers"
> {
  const cacheRead = perMillion(pricing?.input_cache_read);
  const cacheWrite = perMillion(pricing?.input_cache_write);
  const tiers: OpenRouterPriceTier[] = [];
  for (const override of pricing?.overrides ?? []) {
    const min = override.min_prompt_tokens;
    const input = perMillion(override.prompt);
    const output = perMillion(override.completion);
    if (typeof min !== "number" || !Number.isSafeInteger(min) || min <= 0) continue;
    if (input === undefined || output === undefined) continue;
    const tierRead = perMillion(override.input_cache_read);
    const tierWrite = perMillion(override.input_cache_write);
    tiers.push({
      minPromptTokens: min,
      inputPricePerMillion: input,
      outputPricePerMillion: output,
      ...(tierRead !== undefined ? { cacheReadPricePerMillion: tierRead } : {}),
      ...(tierWrite !== undefined ? { cacheWritePricePerMillion: tierWrite } : {}),
    });
  }
  tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  return {
    inputPricePerMillion: perMillion(pricing?.prompt) ?? 0,
    outputPricePerMillion: perMillion(pricing?.completion) ?? 0,
    ...(cacheRead !== undefined ? { cacheReadPricePerMillion: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWritePricePerMillion: cacheWrite } : {}),
    ...(tiers.length ? { priceTiers: tiers } : {}),
  };
}

export interface OpenRouterRequestPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** True when a cache price was not published and was derived from the input price. */
  cachePricesEstimated: boolean;
}

/**
 * Prices for one request. A tier applies to the whole request once its prompt
 * (cached and uncached tokens together) reaches the tier's size. Cache prices
 * missing from the snapshot fall back to read = 10% and write = 125% of input.
 */
export function openRouterRequestPrice(
  model: OpenRouterModel,
  promptTokens = 0,
): OpenRouterRequestPrice {
  let base: OpenRouterPriceTier = {
    minPromptTokens: 0,
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    ...(model.cacheReadPricePerMillion !== undefined
      ? { cacheReadPricePerMillion: model.cacheReadPricePerMillion }
      : {}),
    ...(model.cacheWritePricePerMillion !== undefined
      ? { cacheWritePricePerMillion: model.cacheWritePricePerMillion }
      : {}),
  };
  for (const tier of model.priceTiers ?? []) {
    if (promptTokens >= tier.minPromptTokens) base = tier;
  }
  const input = base.inputPricePerMillion;
  return {
    input,
    output: base.outputPricePerMillion,
    cacheRead: base.cacheReadPricePerMillion ?? input * 0.1,
    cacheWrite: base.cacheWritePricePerMillion ?? input * 1.25,
    cachePricesEstimated:
      base.cacheReadPricePerMillion === undefined || base.cacheWritePricePerMillion === undefined,
  };
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
