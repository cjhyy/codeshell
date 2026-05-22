/**
 * Skills barrel. Phase A keeps the scanner only. Listing rendering lives in
 * src/tool-system/builtin/skill-prompt.ts so the prompt-formatting layer can
 * grow token-budget logic later without churn here.
 */

export { scanSkills, invalidateSkillCache } from "./scanner.js";
export type { SkillDefinition } from "./scanner.js";
