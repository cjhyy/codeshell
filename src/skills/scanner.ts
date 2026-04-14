/**
 * Skills scanner — discovers SKILL.md files and parses their metadata.
 *
 * Skills are markdown files with YAML frontmatter:
 * ---
 * name: skill-name
 * description: what it does
 * triggers:
 *   keywords: [word1, word2]
 *   tools: [ToolName]
 * when_to_use: description of when to invoke
 * ---
 * <skill content>
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: {
    keywords?: string[];
    tools?: string[];
    intents?: string[];
  };
  whenToUse: string;
  content: string;
  filePath: string;
}

/**
 * Scan for SKILL.md files in standard locations.
 */
export function scanSkills(cwd: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();

  const dirs = [
    // Project-level
    join(cwd, ".code-shell", "skills"),
    join(cwd, ".claude", "skills"),
    // User-level
    join(homedir(), ".code-shell", "skills"),
    join(homedir(), ".claude", "skills"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".md") && statSync(join(dir, f)).isFile(),
      );

      for (const file of files) {
        const filePath = resolve(join(dir, file));
        if (seen.has(filePath)) continue;
        seen.add(filePath);

        const skill = parseSkillFile(filePath);
        if (skill) skills.push(skill);
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return skills;
}

/**
 * Parse a single SKILL.md file.
 */
function parseSkillFile(filePath: string): SkillDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) return null;

    const frontmatter = match[1];
    const content = match[2].trim();

    const name = extractField(frontmatter, "name");
    if (!name) return null;

    const description = extractField(frontmatter, "description") ?? "";
    const whenToUse = extractField(frontmatter, "when_to_use") ?? "";

    // Parse triggers
    const keywords = extractList(frontmatter, "keywords");
    const tools = extractList(frontmatter, "tools");
    const intents = extractList(frontmatter, "intents");

    return {
      name,
      description,
      triggers: { keywords, tools, intents },
      whenToUse,
      content,
      filePath,
    };
  } catch {
    return null;
  }
}

function extractField(frontmatter: string, field: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function extractList(frontmatter: string, field: string): string[] {
  const match = frontmatter.match(new RegExp(`${field}:\\s*\\[([^\\]]+)\\]`));
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
}
