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
import { RULES } from "./rules.js";
import {
  type Capability,
  DEFAULT_CAPABILITY,
} from "./types.js";

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
export function capabilitiesFor(
  kind: ProviderKindName,
  model: string,
): Capability {
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
