/**
 * Skill scanner — discovers <base>/<name>/SKILL.md files from project
 * `.code-shell/skills`, project `.agents/skills`, user `.code-shell/skills`,
 * installed plugins, and schema-v2 Panel Apps. Mirrors Claude Code's
 * `loadSkillsFromSkillsDir` (skills/loadSkillsDir.ts:407) plus plugin
 * integration (utils/plugins/pluginLoader.ts).
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { memoize } from "../utils/memoize.js";
import { parseFrontmatter, coerceDescription } from "./frontmatter.js";
import { installedPluginsPath, readInstalledPlugins } from "../plugins/installedPlugins.js";
import { PANEL_APP_MANIFEST_FILE, PanelAppManifest } from "../panel-apps/manifest.js";
import { panelAppsRegistryPath, panelAppsRoot } from "../panel-apps/paths.js";
import {
  isPanelAppBound,
  resolvePanelAppBindingPolicy,
  resolvePanelAppBindingProjectPath,
  type PanelAppBindingPolicy,
} from "../panel-apps/bindings.js";
import { SettingsManager } from "../settings/manager.js";

type SkillSource = "project" | "user" | "plugin" | "panel-app";

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
  source: SkillSource;
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
    { dir: join(cwd, ".agents", "skills"), source: "project" },
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

function resolveContainedPath(root: string, candidate: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function buildSkillFromFile(
  filePath: string,
  defaultName: string,
  source: SkillSource,
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
      const resolvedSkillsDir = resolveContainedPath(entry.installPath, skillsDir);
      if (!resolvedSkillsDir) continue;

      let dirEntries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
      try {
        dirEntries = readdirSync(resolvedSkillsDir, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch (e) {
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[skills] cannot read ${resolvedSkillsDir}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      for (const dirent of dirEntries) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        const namespacedName = `${pluginName}:${dirent.name}`;
        if (pluginSeen.has(namespacedName)) continue;

        const skillDir = resolveContainedPath(
          resolvedSkillsDir,
          join(resolvedSkillsDir, dirent.name),
        );
        if (!skillDir) continue;
        try {
          if (!statSync(skillDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const skillFile = resolveContainedPath(skillDir, join(skillDir, "SKILL.md"));
        if (!skillFile) continue;
        try {
          if (!statSync(skillFile).isFile()) continue;
        } catch {
          continue;
        }
        const raw = readSkillFile(skillFile);
        if (raw === null) continue;

        results.push(buildSkillFromFile(skillFile, dirent.name, "plugin", raw, pluginName));
        pluginSeen.add(namespacedName);
      }
    }
  }
}

function scanInstalledPanelApps(results: SkillDefinition[]): void {
  const root = panelAppsRoot();
  if (!existsSync(root)) return;
  let installedIds: Set<string>;
  try {
    const registry = JSON.parse(readFileSync(panelAppsRegistryPath(), "utf-8")) as {
      version?: unknown;
      apps?: unknown;
    };
    if (registry.version !== 1 || !Array.isArray(registry.apps)) return;
    installedIds = new Set(
      registry.apps
        .map((entry) =>
          entry &&
          typeof entry === "object" &&
          "id" in entry &&
          typeof entry.id === "string" &&
          /^[a-z][a-z0-9-]{0,63}$/.test(entry.id)
            ? entry.id
            : null,
        )
        .filter((id): id is string => id !== null),
    );
  } catch {
    return;
  }
  let appDirectories: { name: string; isDirectory: () => boolean }[];
  try {
    appDirectories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && installedIds.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isInaccessible(error)) return;
    throw error;
  }

  const seen = new Set(results.map((skill) => skill.name));
  for (const directory of appDirectories) {
    const appRoot = join(root, directory.name);
    let manifest: ReturnType<typeof PanelAppManifest.parse>;
    try {
      manifest = PanelAppManifest.parse(
        JSON.parse(readFileSync(join(appRoot, PANEL_APP_MANIFEST_FILE), "utf-8")),
      );
    } catch {
      continue;
    }
    if (manifest.id !== directory.name || manifest.schemaVersion !== 2 || !manifest.agent) continue;
    for (const relativeEntry of manifest.agent.skills) {
      const segments = relativeEntry.split("/");
      const defaultName = segments[2];
      if (!defaultName) continue;
      const namespacedName = `${manifest.id}:${defaultName}`;
      if (seen.has(namespacedName)) continue;
      const skillFile = resolveContainedPath(appRoot, join(appRoot, ...relativeEntry.split("/")));
      if (!skillFile) continue;
      try {
        if (!statSync(skillFile).isFile()) continue;
      } catch {
        continue;
      }
      const raw = readSkillFile(skillFile);
      if (raw === null) continue;
      results.push(buildSkillFromFile(skillFile, defaultName, "panel-app", raw, manifest.id));
      seen.add(namespacedName);
    }
  }
}

function scanOnce(cwd: string): SkillDefinition[] {
  const results: SkillDefinition[] = [];
  const seen = new Set<string>();
  const seenBaseDirs = new Set<string>();

  scanDirBases(bases(cwd), results, seen, seenBaseDirs);
  scanInstalledPlugins(results);
  scanInstalledPanelApps(results);

  return results;
}

function installedPanelAppsMtime(): string {
  return [panelAppsRoot(), panelAppsRegistryPath()]
    .map((path) => {
      try {
        return statSync(path).mtimeMs.toString();
      } catch {
        return "0";
      }
    })
    .join("|");
}

function installedPluginsMtime(): string {
  const p = installedPluginsPath();
  try {
    return statSync(p).mtimeMs.toString();
  } catch {
    return "0";
  }
}

/**
 * mtime of each local skills base dir (project .code-shell/.agents + user). A
 * directory's mtime changes when a child entry is added/removed, so installing
 * a new skill into `<cwd>/.code-shell/skills`, `<cwd>/.agents/skills`, or
 * `~/.code-shell/skills` busts the cache on the next scan — the just-installed
 * skill becomes visible to the running session without a restart. (Editing an
 * existing skill's *contents* does not bump the dir mtime; install paths
 * additionally call invalidateSkillCache() to cover that, so this is the
 * passive half of a two-part guard.)
 */
function skillsDirsMtime(cwd: string): string {
  return bases(cwd)
    .map((b) => {
      try {
        return statSync(b.dir).mtimeMs.toString();
      } catch {
        return "0";
      }
    })
    .join("|");
}

const memoized = memoize(
  scanOnce,
  (cwd: string) =>
    `${cwd}\0${userHome()}\0${installedPluginsMtime()}\0${installedPanelAppsMtime()}\0${skillsDirsMtime(cwd)}`,
);

/**
 * Options accepted by scanSkills. Both filters are applied after the
 * memoized scan returns so the cache stays warm across different filter
 * values — changing `settings.disabledSkills` or `settings.disabledPlugins`
 * should never force a re-scan.
 *
 * - `disabledSkills` names must match the SkillDefinition.name exactly,
 *   including any "<plugin>:" prefix — see scanInstalledPlugins() at
 *   line ~168 for namespace construction.
 * - `disabledPlugins` names are bare plugin names (no colon suffix).
 *   Every skill whose name starts with `${pluginName}:` is filtered.
 *   This is the coarse "plugin total switch" knob; `disabledSkills` is
 *   the per-skill knob.
 */
export interface ScanSkillsOptions {
  disabledSkills?: string[];
  disabledPlugins?: string[];
  /** Include skills owned by Panel Apps disabled or unbound for this project. */
  includeDisabledPanelApps?: boolean;
  /**
   * Hard skill isolation for sub-agents. When set, ONLY skills whose name is
   * in this list survive — every other skill is dropped from the result
   * regardless of the disabled lists. Undefined → no allowlist filtering
   * (parent inherits the full pool). An empty array → no skills at all.
   * Applied after the disabled-list filters, so a skill must be both allowed
   * AND not disabled to appear.
   */
  skillAllowlist?: string[];
}

function panelAppBindingPolicy(cwd: string): PanelAppBindingPolicy {
  try {
    const projectPath = resolvePanelAppBindingProjectPath(cwd);
    const settings = new SettingsManager(projectPath, "full");
    return resolvePanelAppBindingPolicy(
      settings.getForScope("user") as Record<string, unknown>,
      settings.getForScope("project", projectPath) as Record<string, unknown>,
      Boolean(projectPath),
    );
  } catch {
    // Binding failures must not leak every installed Panel App Skill into the
    // project prompt. Fail closed with an empty binding set.
    return resolvePanelAppBindingPolicy(undefined, undefined, false);
  }
}

export function scanSkills(cwd: string, opts?: ScanSkillsOptions): SkillDefinition[] {
  const all = memoized(cwd);
  const disabledSkills = opts?.disabledSkills;
  const disabledPlugins = opts?.disabledPlugins;
  const skillAllowlist = opts?.skillAllowlist;
  const panelPolicy = opts?.includeDisabledPanelApps ? null : panelAppBindingPolicy(cwd);

  const hasSkillFilter = disabledSkills && disabledSkills.length > 0;
  const hasPluginFilter = disabledPlugins && disabledPlugins.length > 0;
  // An allowlist of [] is meaningful (no skills at all), so check for
  // presence with !== undefined, not truthiness/length.
  const hasAllowlist = skillAllowlist !== undefined;
  if (!hasSkillFilter && !hasPluginFilter && !hasAllowlist) {
    if (panelPolicy === null) return all;
    const hasUnboundPanelSkill = all.some((skill) => {
      if (skill.source !== "panel-app") return false;
      const colon = skill.name.indexOf(":");
      return colon <= 0 || !isPanelAppBound(skill.name.slice(0, colon), panelPolicy);
    });
    if (!hasUnboundPanelSkill) return all;
  }

  const skillSet = hasSkillFilter ? new Set(disabledSkills) : null;
  const pluginSet = hasPluginFilter ? new Set(disabledPlugins) : null;
  const allowSet = hasAllowlist ? new Set(skillAllowlist) : null;

  return all.filter((s) => {
    if (panelPolicy && s.source === "panel-app") {
      const colon = s.name.indexOf(":");
      if (colon <= 0 || !isPanelAppBound(s.name.slice(0, colon), panelPolicy)) return false;
    }
    if (allowSet && !allowSet.has(s.name)) return false;
    if (skillSet && skillSet.has(s.name)) return false;
    if (pluginSet && s.source === "plugin") {
      // Use indexOf, not split — skill names may theoretically contain
      // more colons after the first; the namespace boundary is the
      // first ":" only.
      const colon = s.name.indexOf(":");
      if (colon > 0) {
        const prefix = s.name.slice(0, colon);
        if (pluginSet.has(prefix)) return false;
      }
    }
    return true;
  });
}

export function invalidateSkillCache(): void {
  memoized.cache.clear?.();
}
