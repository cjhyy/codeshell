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

interface ModelMetadata {
  knownMaxOutput: Record<string, number>;
  knownContextWindows: Record<string, number>;
  openRouterVendors: OpenRouterVendor[];
}

const METADATA = requireJson("./model-metadata.json") as ModelMetadata;

/** Known max output tokens for direct-provider models (id → tokens). */
export const KNOWN_MAX_OUTPUT: Record<string, number> = METADATA.knownMaxOutput;

/** Known context window sizes for direct-provider models (id → tokens). */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = METADATA.knownContextWindows;

/**
 * Curated vendors and how many of their newest models to surface in the
 * onboarding picker. Order matters — first vendors appear first.
 */
export const OPENROUTER_VENDORS: readonly OpenRouterVendor[] = METADATA.openRouterVendors;
