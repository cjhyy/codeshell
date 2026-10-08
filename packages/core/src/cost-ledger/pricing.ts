import { MODEL_PRICING } from "../data/model-metadata.js";
import { findOpenRouterModel } from "../data/openrouter-models.js";
import type { TokenUsage } from "../types.js";
import type { UsageIdentity, UsageReceipt } from "./types.js";

/** A bundled estimate, never a fallback price or a claim about a provider invoice. */
export function estimateReceipt(
  identity: UsageIdentity,
  usage: TokenUsage,
): Pick<UsageReceipt, "pricing" | "estimatedCostUsd"> {
  const kind = identity.providerKind ?? identity.provider;
  let pricing: UsageReceipt["pricing"] = null;
  if (kind === "openrouter") {
    const hit = findOpenRouterModel(identity.model);
    if (hit && hit.inputPricePerMillion >= 0 && hit.outputPricePerMillion >= 0) {
      pricing = {
        source: "openrouter-snapshot",
        input: hit.inputPricePerMillion,
        output: hit.outputPricePerMillion,
        cacheRead: hit.inputPricePerMillion * 0.1,
        cacheWrite: hit.inputPricePerMillion * 1.25,
        cachePricesEstimated: true,
      };
    }
  } else if (
    ["openai", "anthropic", "deepseek", "zai", "google", "xai", "mistral"].includes(kind)
  ) {
    const model = identity.model.startsWith(`${kind}/`)
      ? identity.model.slice(kind.length + 1)
      : identity.model;
    const hit = MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(/-\d{8}$/, "")];
    if (hit) pricing = { source: "model-metadata", ...hit, cachePricesEstimated: true };
  }
  if (!pricing) return { pricing: null, estimatedCostUsd: null };
  const uncached = Math.max(
    0,
    usage.promptTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheCreationTokens ?? 0),
  );
  return {
    pricing,
    estimatedCostUsd:
      (uncached * pricing.input +
        usage.completionTokens * pricing.output +
        (usage.cacheReadTokens ?? 0) * pricing.cacheRead +
        (usage.cacheCreationTokens ?? 0) * pricing.cacheWrite) /
      1_000_000,
  };
}
