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
      // Prefer the capability's first-class supportedEfforts list (gpt-5.5 →
      // low..xhigh, magistral → [high]). Fall back to the default four levels
      // when a rule didn't specify one. We no longer infer the level set from
      // disabledEffort — that's a wire-detail two vendors can coincidentally
      // share (gpt-5.5 and magistral both use "none"), so inferring misrendered
      // magistral as a gpt-5.5-style control.
      const options =
        r.supportedEfforts && r.supportedEfforts.length > 0
          ? r.supportedEfforts
          : FULL_EFFORTS;
      // Default to "medium" if available, else the first offered level
      // (magistral has only "high", so its default is "high").
      const def: ReasoningEffort = options.includes("medium") ? "medium" : options[0]!;
      return { kind: "effort", options, default: def };
    }
  }
}
