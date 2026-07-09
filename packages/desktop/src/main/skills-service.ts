/**
 * Read-only enumeration of installed skills.
 *
 * The desktop main process imports core's `scanSkills` directly. We
 * don't go through the agent worker for this — the worker isn't
 * running between turns, and the data is purely "what's on disk".
 *
 * If core ever moves the scanner under a sub-export the desktop will
 * fail to compile, which is the right signal: the IPC payload schema
 * here mirrors core's SkillDefinition so we keep them in lockstep.
 */

import {
  SettingsManager,
  computeEffectiveDisabledLists,
  scanSkills,
  invalidateSkillCache,
  userHome,
  type SkillDefinition,
} from "@cjhyy/code-shell-core";
import { assertCodeShellMarkdownPath, rememberCodeShellMarkdownPath } from "./safe-read.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SkillSummary {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
  filePath: string;
}

export interface InstalledSkill {
  name: string;
  targetDir: string;
  filePath: string;
}

export interface UninstallSkillInput {
  scope: "user" | "project";
  cwd?: string;
  skillName: string;
}

export function listSkills(cwd: string, opts?: { includeDisabled?: boolean }): SkillSummary[] {
  let defs: SkillDefinition[];
  try {
    if (opts?.includeDisabled) {
      defs = scanSkills(cwd);
    } else {
      const disabled = computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd);
      defs = scanSkills(cwd, {
        disabledSkills: disabled.disabledSkills,
        disabledPlugins: disabled.disabledPlugins,
      });
    }
  } catch {
    return [];
  }
  return defs.map((d) => {
    rememberCodeShellMarkdownPath(d.filePath);
    return {
      name: d.name,
      description: d.description,
      source: d.source,
      filePath: d.filePath,
    };
  });
}

export async function readSkillBody(filePath: string): Promise<string> {
  assertCodeShellMarkdownPath(filePath);
  return fs.readFile(filePath, "utf8");
}

/**
 * Remove a locally-installed skill. Only honors user and project sources —
 * plugin skills live under externally-managed plugin caches and would
 * grow back on next plugin sync, so deleting them silently would be a
 * lie. Plugin skills should be disabled via `disabledSkills` instead.
 */
export async function uninstallSkill(input: UninstallSkillInput): Promise<void> {
  const skillName = assertSafeSkillName(input.skillName);
  if (input.scope === "project" && !input.cwd) {
    throw new Error("project scope requires cwd");
  }
  const listed = findListedSkill(input.scope, skillName, input.cwd);
  if (!listed) {
    throw new Error(`skill not found: ${skillName}`);
  }
  const skillDir = await safeListedSkillDir(listed.filePath, input.scope, input.cwd);
  await fs.rm(skillDir, { recursive: true, force: true });
  invalidateSkillCache();
}

export async function uninstallListedSkill(
  filePath: string,
  source: "user" | "project" | "plugin",
  cwd?: string,
): Promise<void> {
  if (source === "plugin") {
    throw new Error("plugin skill 不能在此处卸载，请使用「禁用」或移除对应插件");
  }
  const localSource = source;
  if (!cwd) {
    throw new Error("skills:uninstall legacy path form requires cwd");
  }
  const listed = listSkills(cwd, { includeDisabled: true }).find(
    (skill) =>
      skill.source === localSource && path.resolve(skill.filePath) === path.resolve(filePath),
  );
  if (!listed) {
    throw new Error(`refuse to delete unlisted skill: ${filePath}`);
  }
  const skillDir = await safeListedSkillDir(listed.filePath, localSource, cwd);
  await fs.rm(skillDir, { recursive: true, force: true });
  invalidateSkillCache();
}

function findListedSkill(
  scope: "user" | "project",
  skillName: string,
  cwd?: string,
): SkillSummary | null {
  if (!cwd && scope === "user") {
    return {
      name: skillName,
      description: "",
      source: "user",
      filePath: path.join(userSkillRoot(), skillName, "SKILL.md"),
    };
  }
  if (!cwd) return null;
  return (
    listSkills(cwd, { includeDisabled: true }).find(
      (skill) => skill.source === scope && skill.name === skillName,
    ) ?? null
  );
}

async function safeListedSkillDir(
  skillFile: string,
  source: "user" | "project",
  cwd?: string,
): Promise<string> {
  if (!skillFile || path.basename(skillFile) !== "SKILL.md") {
    throw new Error(`invalid skill filePath: ${skillFile}`);
  }
  const fileInfo = await fs.lstat(skillFile);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`refuse to delete skill with unsafe SKILL.md: ${skillFile}`);
  }
  const skillDir = path.dirname(skillFile);
  const dirInfo = await fs.lstat(skillDir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new Error(`refuse to delete unsafe skill directory: ${skillDir}`);
  }
  const dirReal = await fs.realpath(skillDir);
  const roots = source === "user" ? [userSkillRoot()] : projectSkillRoots(cwd);
  for (const root of roots) {
    const rootReal = await fs.realpath(root).catch(() => null);
    if (!rootReal) continue;
    const rel = path.relative(rootReal, dirReal);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep)) {
      const fileReal = await fs.realpath(skillFile);
      if (path.dirname(fileReal) === dirReal) return dirReal;
    }
  }
  throw new Error(`refuse to delete: ${skillDir} is outside known skill roots`);
}

function assertSafeSkillName(skillName: string): string {
  if (typeof skillName !== "string") throw new Error("skillName must be a string");
  const name = skillName.trim();
  if (!name || name === "." || name === "..") throw new Error("skillName must be non-empty");
  if (name.includes("/") || name.includes("\\") || name.includes("\0") || name.includes("..")) {
    throw new Error(`invalid skillName: ${skillName}`);
  }
  return name;
}

function userSkillRoot(): string {
  return path.join(userHome(), ".code-shell", "skills");
}

function projectSkillRoots(cwd?: string): string[] {
  if (!cwd) throw new Error("project scope requires cwd");
  return [path.join(cwd, ".code-shell", "skills"), path.join(cwd, ".agents", "skills")];
}

export async function installSkillFromDirectory(
  sourceDir: string,
  scope: "user" | "project",
  cwd?: string,
  requestedName?: string,
): Promise<InstalledSkill> {
  const source = path.resolve(sourceDir);
  const skillFile = path.join(source, "SKILL.md");
  await fs.access(skillFile);

  const name = normalizeSkillName(requestedName || path.basename(source));
  const root = scope === "user" ? userSkillRoot() : projectSkillRoot(cwd);
  const targetDir = path.join(root, name);

  try {
    await fs.access(targetDir);
    throw new Error(`Skill "${name}" 已存在：${targetDir}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  await fs.mkdir(root, { recursive: true });
  await fs.cp(source, targetDir, {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith(".git"),
  });

  // The dir-mtime cache key (core scanner) busts on the new child, but clear
  // explicitly too so main's own listSkills() reflects the install immediately.
  invalidateSkillCache();

  const filePath = path.join(targetDir, "SKILL.md");
  rememberCodeShellMarkdownPath(filePath);
  return {
    name,
    targetDir,
    filePath,
  };
}

function projectSkillRoot(cwd?: string): string {
  if (!cwd) throw new Error("project scope requires cwd");
  return path.join(cwd, ".code-shell", "skills");
}

function normalizeSkillName(input: string): string {
  const name = input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!name) throw new Error("Skill 名称不能为空");
  return name;
}
