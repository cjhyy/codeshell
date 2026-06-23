/**
 * Hand-maintained model metadata for direct-provider models and onboarding
 * picker tuning, extracted out of onboarding.ts so updating a model's
 * max-output / context-window or the picker vendor list is a data edit
 * (model-metadata.json) rather than a code change.
 *
 * Scope: only what the build-time OpenRouter snapshot does NOT cover —
 * direct-provider ids (no "vendor/" prefix) for the metadata tables, plus the
 * curated OpenRouter vendor ordering for the picker. OpenRouter "vendor/model"
 * ids get their context/max-output from the snapshot (see data/openrouter-*).
 *
 * Loaded with createRequire so the bundled JSON ships in dist (the build copies
 * src/data/*.json → dist/data/), matching static-catalogs.ts.
 */

import { createRequire } from "node:module";

const requireJson = createRequire(import.meta.url);

export interface OpenRouterVendor {
  prefix: string;
  take: number;
}

/** Per-1M-token pricing (USD). Mirrors cost-tracker's ModelPricing. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelMetadata {
  knownMaxOutput: Record<string, number>;
  knownContextWindows: Record<string, number>;
  openRouterVendors: OpenRouterVendor[];
  /** [model-id-prefix, env-var-name] — first prefix match wins; order matters. */
  vertexRegionOverrides: Array<[string, string]>;
  /** model-id → [inputPerM, outputPerM]; cache prices derived (see pricingFromPair). */
  pricing: Record<string, [number, number]>;
  pricingDefault: [number, number];
}

const METADATA = requireJson("./model-metadata.json") as ModelMetadata;

/**
 * Derive a full ModelPricing from an [input, output] pair, applying the
 * standard cache-price heuristic (read = 10% of input, write = 125% of input).
 * This is the same derivation the old `pricing()` helper in cost-tracker used;
 * the previously-explicit Anthropic cacheRead/cacheWrite values equalled this
 * heuristic exactly, so moving every entry to a pair causes zero value drift.
 */
function pricingFromPair([input, output]: [number, number]): ModelPricing {
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

/** Known max output tokens for direct-provider models (id → tokens). */
export const KNOWN_MAX_OUTPUT: Record<string, number> = METADATA.knownMaxOutput;

/** Known context window sizes for direct-provider models (id → tokens). */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = METADATA.knownContextWindows;

/**
 * Curated vendors and how many of their newest models to surface in the
 * onboarding picker. Order matters — first vendors appear first.
 */
export const OPENROUTER_VENDORS: readonly OpenRouterVendor[] = METADATA.openRouterVendors;

/**
 * Model-id prefix → env var holding a Vertex region override. First matching
 * prefix wins (order matters); the resolver reads `process.env[name]` and falls
 * back to the default region when unset. Consumed by envUtils.getVertexRegionForModel.
 */
export const VERTEX_REGION_OVERRIDES: ReadonlyArray<readonly [string, string]> =
  METADATA.vertexRegionOverrides;

/**
 * Per-model pricing for direct-provider ids (USD per 1M tokens), resolved to
 * full ModelPricing (input/output from data, cacheRead/cacheWrite derived).
 * OpenRouter vendor/model ids price from the build-time snapshot instead.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(METADATA.pricing).map(([id, pair]) => [id, pricingFromPair(pair)]),
);

/** Fallback pricing for models absent from MODEL_PRICING and the snapshot. */
export const DEFAULT_PRICING: ModelPricing = pricingFromPair(METADATA.pricingDefault);
