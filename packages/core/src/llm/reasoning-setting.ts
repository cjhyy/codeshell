/**
 * ReasoningSetting — the rich, normalized reasoning/thinking config that
 * replaces the old binary `thinking: "enabled"|"disabled"`.
 *
 *  - off    : no thinking (openai-effort → disabledEffort; deepseek → type:disabled; openrouter → exclude)
 *  - on     : binary "thinking on" for deepseek-thinking / zai (no effort levels)
 *  - effort : openai-effort / openrouter — pick a level
 *  - budget : anthropic-budget — explicit thinking token budget
 *
 * `normalizeReasoning` accepts the legacy "enabled"/"disabled" strings so any
 * lingering caller/config still works (mapped to on/off).
 */
import { z } from "zod";
import type { ReasoningEffort } from "./capabilities/types.js";

// Recommended effort levels — used to render UI dropdowns and as capability
// hints. NOT a hard schema constraint: effort is a free-form, catalog-driven
// param (a model's real ladder is declared by its catalog ParamSpec, and models
// gain/rename levels over time — e.g. gpt-5.5 added "xhigh", some models accept
// "max"). The settings schema validates the *shape* (mode/field names), not the
// *value*; pinning effort to a closed enum here made one unknown level
// (a connection's paramValues.reasoning flowing through the legacy models[]
// bridge) throw in validateSettings and take the whole app down on boot.
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ReasoningSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("effort"), effort: z.string().min(1) }),
  z.object({ mode: z.literal("budget"), budgetTokens: z.number().int().positive() }),
]);

export type ReasoningSetting = z.infer<typeof ReasoningSettingSchema>;

/** Coerce legacy "enabled"/"disabled" or an object into a ReasoningSetting. */
export function normalizeReasoning(
  raw: ReasoningSetting | "enabled" | "disabled" | undefined,
): ReasoningSetting | undefined {
  if (raw == null) return undefined;
  if (raw === "enabled") return { mode: "on" };
  if (raw === "disabled") return { mode: "off" };
  return raw;
}

/** Effort to send when a model wants "thinking on" but the user picked no level. */
export const DEFAULT_EFFORT: ReasoningEffort = "medium";
