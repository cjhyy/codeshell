import { existsSync, readdirSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { PluginInstallError } from "../types.js";

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---/;

/**
 * Copy <sourceDir>/skills into <destDir>/skills verbatim (Codex & CC SKILL.md
 * are isomorphic). Validates each SKILL.md has a frontmatter block first — a
 * malformed skill fails the whole install (spec §10).
 */
export function copyCodexSkills(sourceDir: string, destDir: string): void {
  const skillsSrc = join(sourceDir, "skills");
  if (!existsSync(skillsSrc)) return;

  for (const dirent of readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const skillFile = join(skillsSrc, dirent.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const raw = readFileSync(skillFile, "utf-8").trim();
    if (!FRONTMATTER.test(raw)) {
      throw new PluginInstallError(`skills/${dirent.name}/SKILL.md: missing frontmatter`);
    }
  }
  cpSync(skillsSrc, join(destDir, "skills"), { recursive: true });
}
