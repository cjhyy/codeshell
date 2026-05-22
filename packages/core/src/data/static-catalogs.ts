/**
 * Hand-maintained static model catalogs for providers whose /v1/models
 * endpoint returns only ids — no context window, max output, or pricing.
 *
 * At runtime we still call the live /models endpoint to discover ids
 * (so newly-released models work without a code update), then left-join
 * this table on `id` to fill in metadata. Edit the JSONs in src/data/
 * when a vendor ships a new model.
 *
 * OpenRouter is NOT here — its catalog is generated at build time by
 * scripts/sync-models.ts because OpenRouter exposes full metadata.
 */

import { createRequire } from "node:module";
import type { ProviderKindName } from "../llm/provider-kinds.js";

const requireJson = createRequire(import.meta.url);

export interface StaticModel {
  id: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modalities: string[];
  thinking?: boolean;
}

interface StaticCatalog {
  fetchedAt: string;
  source: string;
  count: number;
  models: StaticModel[];
}

const TABLES: Partial<Record<ProviderKindName, StaticCatalog>> = {
  deepseek: requireJson("./deepseek-models.json") as StaticCatalog,
  zai: requireJson("./zai-models.json") as StaticCatalog,
  openai: requireJson("./openai-models.json") as StaticCatalog,
  google: requireJson("./gemini-models.json") as StaticCatalog,
};

export function listStaticModels(kind: ProviderKindName): StaticModel[] {
  return TABLES[kind]?.models ?? [];
}

export function hasStaticCatalog(kind: ProviderKindName): boolean {
  return TABLES[kind] !== undefined;
}
