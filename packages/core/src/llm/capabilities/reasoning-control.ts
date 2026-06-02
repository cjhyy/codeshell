/**
 * reasoningControlFor — projects a model's ReasoningShape into "what control
 * the UI should render". The UI never branches on provider; it switches on
 * ReasoningControl.kind. Mirrors the capability-control descriptor pattern.
 */
import type { ProviderKindName } from "../provider-kinds.js";
import type { ReasoningEffort } from "./types.js";
import { capabilitiesFor } from "./index.js";

export type ReasoningControl =
  | { kind: "none" }
  | { kind: "toggle"; default: boolean }
  | { kind: "effort"; options: ReasoningEffort[]; default: ReasoningEffort }
  | { kind: "budget"; min: number; default: number }
  | { kind: "adaptive" };

const FULL_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
// gpt-5.5+: drops "minimal", adds "xhigh" (signalled by disabledEffort === "none").
const GPT55_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function reasoningControlFor(
  kind: ProviderKindName,
  model: string,
): ReasoningControl {
  const cap = capabilitiesFor(kind, model);
  const r = cap.reasoning;
  switch (r.kind) {
    case "none":
      return { kind: "none" };
    case "deepseek-thinking":
      return { kind: "toggle", default: true };
    case "anthropic-adaptive":
      return { kind: "adaptive" };
    case "anthropic-budget":
      return {
        kind: "budget",
        min: r.minBudgetTokens,
        default: Math.max(r.minBudgetTokens, 4096),
      };
    case "openrouter-reasoning":
      // OpenRouter normalizes to minimal..high (no xhigh passthrough).
      return { kind: "effort", options: FULL_EFFORTS, default: "medium" };
    case "openai-effort": {
      // disabledEffort === "none" is the gpt-5.5+ signal (no minimal, has xhigh).
      const isGpt55 = r.disabledEffort === "none";
      const options = isGpt55 ? GPT55_EFFORTS : FULL_EFFORTS;
      return { kind: "effort", options, default: "medium" };
    }
  }
}
