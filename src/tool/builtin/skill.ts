/**
 * SkillTool — invoke custom skills/plugins by name.
 */

import type { ToolDefinition } from "../../types.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const skillToolDef: ToolDefinition = {
  name: "Skill",
  description:
    "Execute a skill within the main conversation. Skills provide specialized capabilities " +
    "and domain knowledge. Use this tool with the skill name and optional arguments.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name to invoke (e.g., 'commit', 'review-pr', 'pdf')",
      },
      args: {
        type: "string",
        description: "Optional arguments for the skill",
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

  // Search for skill in known directories
  const searchDirs = [
    join(process.cwd(), ".code-shell", "skills"),
    join(homedir(), ".code-shell", "skills"),
  ];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const name = file.replace(/\.md$/, "");
      if (name === skillName || name === skillName.replace(/^\//, "")) {
        const content = readFileSync(join(dir, file), "utf-8");
        // Parse frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        const body = fmMatch ? fmMatch[2].trim() : content.trim();

        // Replace $ARGUMENTS placeholder
        const processed = body.replace(/\$ARGUMENTS/g, skillArgs).replace(/\{args\}/g, skillArgs);
        return `Skill "${skillName}" loaded:\n\n${processed}`;
      }
    }
  }

  return `Skill "${skillName}" not found. Available skills can be found in .code-shell/skills/ or ~/.code-shell/skills/`;
}
