import type { ProviderKindName } from "../provider-kinds.js";
import type { PromptCachingCapability } from "./types.js";

/**
 * Explicit model declarations, shared by direct and gateway routes. Unknown
 * models retain the provider default; a catalog preset can declare support for
 * custom deployment names without changing client code or guessing versions.
 * Source: https://developers.openai.com/api/docs/guides/prompt-caching
 */
const OPENAI_MODEL_CACHE_CAPABILITIES: ReadonlyMap<string, PromptCachingCapability> = new Map([
  ["gpt-5.6-sol", "openai-hybrid"],
  ["gpt-5.6-terra", "openai-hybrid"],
  ["gpt-5.6-luna", "openai-hybrid"],
  ["gpt-6-sol", "openai-hybrid"],
  ["gpt-6-terra", "openai-hybrid"],
  ["gpt-6-astra", "openai-hybrid"],
  ["gpt-6.1-sol", "openai-hybrid"],
  ["gpt-6.1-sol-pro", "openai-hybrid"],
  ["gpt-6.1-terra", "openai-hybrid"],
]);

/** Resolve the model's declared cache protocol through its provider identity. */
export function promptCachingForModel(
  kind: ProviderKindName,
  model: string,
): PromptCachingCapability {
  const normalized = (model.startsWith("~") ? model.slice(1) : model).toLowerCase();
  const separator = normalized.indexOf("/");
  const vendor = separator === -1 ? undefined : normalized.slice(0, separator);
  const modelId = separator === -1 ? normalized : normalized.slice(separator + 1);
  const upstream = kind === "openrouter" ? vendor : kind;
  if (upstream === "anthropic") return "anthropic-explicit";
  if (upstream === "openai") {
    return OPENAI_MODEL_CACHE_CAPABILITIES.get(modelId) ?? "openai-implicit";
  }
  return "provider-managed";
}
