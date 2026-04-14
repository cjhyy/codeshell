/**
 * Skill matcher — determines which skills are relevant for a given input/context.
 */

import type { SkillDefinition } from "./scanner.js";

export interface MatchResult {
  skill: SkillDefinition;
  score: number;
  matchedBy: string; // "keyword" | "tool" | "intent"
}

/**
 * Match skills against user input text.
 */
export function matchSkillsByInput(
  skills: SkillDefinition[],
  input: string,
): MatchResult[] {
  const inputLower = input.toLowerCase();
  const results: MatchResult[] = [];

  for (const skill of skills) {
    let bestScore = 0;
    let matchedBy = "";

    // Keyword matching
    if (skill.triggers.keywords) {
      for (const kw of skill.triggers.keywords) {
        if (inputLower.includes(kw.toLowerCase())) {
          const score = kw.length / input.length * 10 + 5;
          if (score > bestScore) {
            bestScore = score;
            matchedBy = "keyword";
          }
        }
      }
    }

    // Intent matching (simple substring match)
    if (skill.triggers.intents) {
      for (const intent of skill.triggers.intents) {
        if (inputLower.includes(intent.toLowerCase())) {
          const score = 8;
          if (score > bestScore) {
            bestScore = score;
            matchedBy = "intent";
          }
        }
      }
    }

    if (bestScore > 0) {
      results.push({ skill, score: bestScore, matchedBy });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Match skills by tool name being used.
 */
export function matchSkillsByTool(
  skills: SkillDefinition[],
  toolName: string,
): MatchResult[] {
  return skills
    .filter((s) => s.triggers.tools?.includes(toolName))
    .map((skill) => ({ skill, score: 10, matchedBy: "tool" }));
}

/**
 * Build a skill listing for the system prompt.
 */
export function buildSkillListing(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) =>
      `- **${s.name}**: ${s.description}${s.whenToUse ? ` — Use when: ${s.whenToUse}` : ""}`,
  );

  return `# Available Skills\n\n${lines.join("\n")}`;
}
