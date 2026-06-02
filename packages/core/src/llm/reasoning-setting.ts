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

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ReasoningSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("on") }),
  z.object({ mode: z.literal("effort"), effort: z.enum(REASONING_EFFORTS) }),
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
