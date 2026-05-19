/**
 * SkillTool — load a skill's SKILL.md body and return it as the tool result.
 * The scanner is the single source of truth; this tool never reads the disk
 * directly. Matches Claude Code's tools/SkillTool/SkillTool.ts pattern.
 */

import type { ToolDefinition } from "../../types.js";
import { scanSkills } from "../../skills/scanner.js";

export const skillToolDef: ToolDefinition = {
  name: "Skill",
  description:
    "Execute a skill within the main conversation. Skills provide specialized " +
    "capabilities and domain knowledge. Use this tool with the skill name and " +
    "optional arguments.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name to invoke (e.g., 'pdf', 'brainstorming')",
      },
      args: {
        type: "string",
        description: "Optional arguments substituted into $ARGUMENTS / {args} placeholders",
      },
    },
    required: ["skill"],
  },
};

export async function skillTool(args: Record<string, unknown>): Promise<string> {
  const skillName = args.skill as string;
  const skillArgs = (args.args as string) ?? "";

  if (!skillName) {
    return "Error: skill name is required.";
  }

  const skills = scanSkills(process.cwd());
  const found = skills.find((s) => s.name === skillName);

  if (!found) {
    return `Skill "${skillName}" not found. Run /skills to list available skills.`;
  }

  return found.content
    .replace(/\$ARGUMENTS/g, skillArgs)
    .replace(/\{args\}/g, skillArgs);
}
