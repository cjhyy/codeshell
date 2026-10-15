/**
 * Capability layer — single entry point.
 *
 * `capabilitiesFor(kind, model)` walks the rules in `rules.ts`, returns
 * a `Capability` describing what params the (provider, model) pair will
 * accept. Clients spread the result into their request-build code.
 *
 * Pure function. No I/O, no caching beyond the rules array.
 */

import type { ProviderKindName } from "../provider-kinds.js";
import type { LLMConfig } from "../../types.js";
import { RULES } from "./rules.js";
import { type Capability, DEFAULT_CAPABILITY } from "./types.js";

export { DEFAULT_CAPABILITY } from "./types.js";
export type {
  Capability,
  ReasoningShape,
  ReasoningEffort,
  ThinkingSwitch,
  EchoReasoning,
  ParallelToolCallsShape,
  StreamUsageShape,
} from "./types.js";

/**
 * Resolve the capability for a given (provider kind, model id).
 *
 * First matching rule for the kind wins — rules.ts is ordered so that
 * more specific patterns come before catch-alls.
 */
export function capabilitiesFor(kind: ProviderKindName, model: string): Capability {
  for (const rule of RULES) {
    if (rule.kind !== kind) continue;
    if (!rule.match.test(model)) continue;
    return {
      ...DEFAULT_CAPABILITY,
      ...rule.capability,
      // Set fields need explicit merge — Object spread copies the
      // reference but the caller might mutate it. Keep DEFAULT immutable.
      rejectedParams: rule.capability.rejectedParams
        ? new Set(rule.capability.rejectedParams)
        : new Set(DEFAULT_CAPABILITY.rejectedParams),
    };
  }
  return {
    ...DEFAULT_CAPABILITY,
    rejectedParams: new Set(DEFAULT_CAPABILITY.rejectedParams),
  };
}

/**
 * Runtime capabilities for the selected connection/model. Catalog metadata is
 * authoritative (including false); rules only fill undeclared capabilities.
 * Keep this pure so tools and provider request filtering use the same source.
 */
export function capabilitiesForConfig(
  config?: Pick<LLMConfig, "provider" | "providerKind" | "model" | "supportsVision">,
): Capability {
  if (!config?.model || !(config.providerKind ?? config.provider)) {
    return { ...DEFAULT_CAPABILITY, rejectedParams: new Set(DEFAULT_CAPABILITY.rejectedParams) };
  }
  const capability = capabilitiesFor(
    (config.providerKind ?? config.provider) as ProviderKindName,
    config.model,
  );
  return {
    ...capability,
    supportsVision:
      typeof config.supportsVision === "boolean"
        ? config.supportsVision
        : capability.supportsVision,
  };
}
