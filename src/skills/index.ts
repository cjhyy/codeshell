/**
 * Skills system — scan, match, and inject skills into prompts.
 */

export { scanSkills } from "./scanner.js";
export type { SkillDefinition } from "./scanner.js";
export { matchSkillsByInput, matchSkillsByTool, buildSkillListing } from "./matcher.js";
export type { MatchResult } from "./matcher.js";
