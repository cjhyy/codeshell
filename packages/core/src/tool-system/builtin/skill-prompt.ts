/**
 * Skill listing renderer for the system prompt. Mirrors Claude Code's split
 * between scan/data layer (skills/scanner.ts) and render layer (this file),
 * matching tools/SkillTool/prompt.ts in CC.
 */

import type { SkillDefinition } from "../../skills/scanner.js";

export function buildSkillListing(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) =>
    s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}:`,
  );
  return `# Available Skills\n\n${lines.join("\n")}`;
}
