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
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

  const builtin = resolveBuiltinSkillsDir();

  const dirs = [
    // Project-level
    join(cwd, ".code-shell", "skills"),
    join(cwd, ".claude", "skills"),
    // User-level
    join(homedir(), ".code-shell", "skills"),
    join(homedir(), ".claude", "skills"),
    // Built-in (shipped inside the npm package). Listed last so user/project
    // skills with the same filename win deduplication on filePath.
    ...(builtin ? [builtin] : []),
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
 * Locate the `skills-builtin/` directory shipped with the npm package.
 * Walks up from this module file (`dist/...` after build, or `src/skills/...`
 * in dev) until it finds a `package.json` whose `name` is the package, then
 * looks for a sibling `skills-builtin/` folder.
 */
function resolveBuiltinSkillsDir(): string | null {
  let here: string;
  try {
    here =
      typeof import.meta !== "undefined" && import.meta.url
        ? dirname(fileURLToPath(import.meta.url))
        : __dirname;
  } catch {
    return null;
  }

  let dir = here;
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg?.name === "@cjhyy/code-shell") {
        const candidate = join(dir, "skills-builtin");
        return existsSync(candidate) ? candidate : null;
      }
    } catch {
      // not here, walk up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
