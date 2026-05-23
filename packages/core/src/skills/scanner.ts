/**
 * Skill scanner — discovers <base>/<name>/SKILL.md files from project + user
 * directories AND from installed plugins. Mirrors Claude Code's
 * `loadSkillsFromSkillsDir` (skills/loadSkillsDir.ts:407) plus plugin
 * integration (utils/plugins/pluginLoader.ts).
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { memoize } from "../utils/memoize.js";
import { parseFrontmatter, coerceDescription } from "./frontmatter.js";
import { installedPluginsPath, readInstalledPlugins } from "../plugins/installedPlugins.js";

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
  source: "project" | "user" | "plugin";
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

function readSkillFile(skillFile: string): string | null {
  try {
    return readFileSync(skillFile, "utf-8");
  } catch (e) {
    if (isENOENT(e)) return null;
    if (isInaccessible(e)) {
      // eslint-disable-next-line no-console
      console.warn(`[skills] cannot read ${skillFile}: ${(e as Error).message}`);
      return null;
    }
    throw e;
  }
}

function buildSkillFromFile(
  filePath: string,
  defaultName: string,
  source: "project" | "user" | "plugin",
  raw: string,
  namePrefix?: string,
): SkillDefinition {
  const { frontmatter, body } = parseFrontmatter(raw);
  const fmName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  if (fmName !== undefined && fmName !== defaultName) {
    // eslint-disable-next-line no-console
    console.warn(
      `[skills] frontmatter.name "${fmName}" in ${filePath} does not match directory name "${defaultName}"; using directory name`,
    );
  }
  const description = coerceDescription(frontmatter.description);
  const name = namePrefix ? `${namePrefix}:${defaultName}` : defaultName;
  return { name, description, content: body, filePath, source };
}

function scanDirBases(
  bases: ScanBase[],
  results: SkillDefinition[],
  seen: Set<string>,
  seenBaseDirs: Set<string>,
): void {
  for (const { dir, source } of bases) {
    if (!existsSync(dir)) continue;

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
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
      const raw = readSkillFile(skillFile);
      if (raw === null) continue;

      results.push(buildSkillFromFile(skillFile, entry.name, source, raw));
      seen.add(entry.name);
    }
  }
}

function scanInstalledPlugins(results: SkillDefinition[]): void {
  const data = readInstalledPlugins();
  const pluginSeen = new Set<string>();

  // Stable order so /skills output is deterministic.
  const keys = Object.keys(data.plugins).sort();
  for (const key of keys) {
    const entries = data.plugins[key] ?? [];
    // <plugin>@<marketplace>
    const atIdx = key.lastIndexOf("@");
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;

    for (const entry of entries) {
      const skillsDir = join(entry.installPath, "skills");
      if (!existsSync(skillsDir)) continue;

      let dirEntries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
      try {
        dirEntries = readdirSync(skillsDir, { withFileTypes: true });
      } catch (e) {
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[skills] cannot read ${skillsDir}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      for (const dirent of dirEntries) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const namespacedName = `${pluginName}:${dirent.name}`;
        if (pluginSeen.has(namespacedName)) continue;

        const skillFile = join(skillsDir, dirent.name, "SKILL.md");
        const raw = readSkillFile(skillFile);
        if (raw === null) continue;

        results.push(
          buildSkillFromFile(skillFile, dirent.name, "plugin", raw, pluginName),
        );
        pluginSeen.add(namespacedName);
      }
    }
  }
}

function scanOnce(cwd: string): SkillDefinition[] {
  const results: SkillDefinition[] = [];
  const seen = new Set<string>();
  const seenBaseDirs = new Set<string>();

  scanDirBases(bases(cwd), results, seen, seenBaseDirs);
  scanInstalledPlugins(results);

  return results;
}

function installedPluginsMtime(): string {
  const p = installedPluginsPath();
  try {
    return statSync(p).mtimeMs.toString();
  } catch {
    return "0";
  }
}

const memoized = memoize(
  scanOnce,
  (cwd: string) => `${cwd}\0${userHome()}\0${installedPluginsMtime()}`,
);

export function scanSkills(cwd: string): SkillDefinition[] {
  return memoized(cwd);
}

export function invalidateSkillCache(): void {
  memoized.cache.clear?.();
}
