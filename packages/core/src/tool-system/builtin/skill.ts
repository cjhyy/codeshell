/**
 * SkillTool — load a skill's SKILL.md body and return it as the tool result.
 * The scanner is the single source of truth; this tool never reads the disk
 * directly. Matches Claude Code's tools/SkillTool/SkillTool.ts pattern.
 */

import { dirname } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
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

export async function skillTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const skillName = args.skill as string;
  const skillArgs = (args.args as string) ?? "";

  if (!skillName) {
    return "Error: skill name is required.";
  }

  // Reject disabled skills before scanning so the user gets a clear
  // message that distinguishes "disabled" from "not found" — matches
  // the UI's toggle semantics. The scanner would also filter the entry
  // out, which alone would produce a misleading "not found" reply.
  const disabledSkills = ctx?.disabledSkills;
  if (disabledSkills && disabledSkills.includes(skillName)) {
    return `Skill "${skillName}" is disabled. Enable it in Customize or remove it from settings.disabledSkills.`;
  }

  // A4: scan skills from the Engine's cwd, not the host process cwd.
  const skills = scanSkills(ctx?.cwd ?? process.cwd(), { disabledSkills });
  const found = skills.find((s) => s.name === skillName);

  if (!found) {
    return `Skill "${skillName}" not found. Run /skills to list available skills.`;
  }

  const skillDir = dirname(found.filePath);
  const body = found.content
    .replace(/\$ARGUMENTS/g, skillArgs)
    .replace(/\{args\}/g, skillArgs)
    .replace(/\$\{CODESHELL_SKILL_DIR\}/g, skillDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);
  return `Base directory for this skill: ${skillDir}\n\n${body}`;
}
