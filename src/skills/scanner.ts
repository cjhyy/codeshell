/**
 * Skill scanner — discovers <base>/<name>/SKILL.md files. Mirrors Claude Code's
 * `loadSkillsFromSkillsDir` (skills/loadSkillsDir.ts:407) so community skill
 * repositories drop in without modification.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import memoize from "lodash-es/memoize.js";
import { parseFrontmatter, coerceDescription } from "./frontmatter.js";

export interface SkillDefinition {
  /** Directory name; authoritative regardless of frontmatter.name. */
  name: string;
  /** From frontmatter.description, coerced. Empty string if absent or invalid. */
  description: string;
  /** SKILL.md body with frontmatter stripped. */
  content: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Where the skill was loaded from. */
  source: "project" | "user";
}

interface ScanBase {
  dir: string;
  source: "project" | "user";
}

function userHome(): string {
  // Honor process.env.HOME so tests (and shell overrides) can redirect the
  // user-skills lookup. node:os homedir() reads from getpwuid and ignores
  // later mutations of process.env.HOME, which is what the test suite relies
  // on. Falls back to homedir() when HOME is unset.
  return process.env.HOME ?? homedir();
}

function bases(cwd: string): ScanBase[] {
  return [
    { dir: join(cwd, ".code-shell", "skills"), source: "project" },
    { dir: join(userHome(), ".code-shell", "skills"), source: "user" },
  ];
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "ENOENT"
  );
}

function isInaccessible(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("code" in e)) return false;
  const code = (e as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" || code === "EIO";
}

function scanOnce(cwd: string): SkillDefinition[] {
  const results: SkillDefinition[] = [];
  const seen = new Set<string>();
  const seenBaseDirs = new Set<string>();

  for (const { dir, source } of bases(cwd)) {
    if (!existsSync(dir)) continue;

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      // dir disappeared between existsSync and realpathSync, or unreadable
      continue;
    }
    if (seenBaseDirs.has(realDir)) continue;
    seenBaseDirs.add(realDir);

    let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isInaccessible(e)) {
        // eslint-disable-next-line no-console
        console.warn(`[skills] cannot read ${dir}: ${(e as Error).message}`);
        continue;
      }
      throw e;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (seen.has(entry.name)) continue;

      const skillFile = join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf-8");
      } catch (e) {
        if (isENOENT(e)) continue;
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[skills] cannot read ${skillFile}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      const { frontmatter, body } = parseFrontmatter(raw);
      const fmName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
      if (fmName !== undefined && fmName !== entry.name) {
        // eslint-disable-next-line no-console
        console.warn(
          `[skills] frontmatter.name "${fmName}" in ${skillFile} does not match directory name "${entry.name}"; using directory name`,
        );
      }
      const description = coerceDescription(frontmatter.description);

      results.push({
        name: entry.name,
        description,
        content: body,
        filePath: skillFile,
        source,
      });
      seen.add(entry.name);
    }
  }

  return results;
}

const memoized = memoize(scanOnce, (cwd: string) => `${cwd}\0${userHome()}`);

export function scanSkills(cwd: string): SkillDefinition[] {
  return memoized(cwd);
}

export function invalidateSkillCache(): void {
  memoized.cache.clear?.();
}
