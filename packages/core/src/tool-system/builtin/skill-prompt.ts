/**
 * Skill listing renderer for the system prompt. Mirrors Claude Code's split
 * between scan/data layer (skills/scanner.ts) and render layer (this file),
 * matching tools/SkillTool/prompt.ts in CC.
 */

import type { SkillDefinition } from "../../skills/scanner.js";

/**
 * Render the system-prompt skill listing grouped by namespace.
 *
 * Skill names follow the convention `<namespace>:<short>` for plugin
 * skills (see scanner.ts's `namespacedName`) and plain `<short>` for
 * skills the user installs into ~/.code-shell/skills or the project's
 * .code-shell/skills directory.
 *
 * A flat list grew unreadable once a few plugins were installed, and
 * the LLM had to skim 40+ lines under a single heading. Grouping by
 * namespace keeps related skills adjacent and lets the LLM scan
 * intents ("which plugin handles X?") in one pass.
 */
export function buildSkillListing(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  // Bucket by the part before the first ":" — that is either the
  // plugin name (e.g. "superpowers") or an empty namespace for
  // user/project skills, which we group under a friendlier label.
  const USER_GROUP = "用户 / 项目";
  const groups = new Map<string, SkillDefinition[]>();
  for (const s of skills) {
    const colon = s.name.indexOf(":");
    const key = colon > 0 ? s.name.slice(0, colon) : USER_GROUP;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  // Stable order: user/project first, then plugin namespaces
  // alphabetically. The LLM benefits from a predictable layout.
  const entries = [...groups.entries()].sort(([a], [b]) => {
    if (a === USER_GROUP) return -1;
    if (b === USER_GROUP) return 1;
    return a.localeCompare(b);
  });

  const sections: string[] = [];
  for (const [group, list] of entries) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    const lines = list.map((s) =>
      s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}:`,
    );
    sections.push(`## ${group} (${list.length})\n${lines.join("\n")}`);
  }

  return `# Available Skills\n\n${sections.join("\n\n")}`;
}
