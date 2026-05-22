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

import deepseekJson from "./deepseek-models.json";
import zaiJson from "./zai-models.json";
import openaiJson from "./openai-models.json";
import geminiJson from "./gemini-models.json";
import type { ProviderKindName } from "../llm/provider-kinds.js";

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
  deepseek: deepseekJson as StaticCatalog,
  zai: zaiJson as StaticCatalog,
  openai: openaiJson as StaticCatalog,
  google: geminiJson as StaticCatalog,
};

export function listStaticModels(kind: ProviderKindName): StaticModel[] {
  return TABLES[kind]?.models ?? [];
}

export function hasStaticCatalog(kind: ProviderKindName): boolean {
  return TABLES[kind] !== undefined;
}
