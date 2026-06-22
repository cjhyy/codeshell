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

import { scanSkills, invalidateSkillCache, type SkillDefinition } from "@cjhyy/code-shell-core";
import { assertCodeShellMarkdownPath } from "./safe-read.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
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

export function listSkills(cwd: string): SkillSummary[] {
  let defs: SkillDefinition[];
  try {
    defs = scanSkills(cwd);
  } catch {
    return [];
  }
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    source: d.source,
    filePath: d.filePath,
  }));
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
export async function uninstallSkill(
  filePath: string,
  source: "user" | "project" | "plugin",
): Promise<void> {
  if (source === "plugin") {
    throw new Error("plugin skill 不能在此处卸载，请使用「禁用」或移除对应插件");
  }
  if (!filePath || !filePath.endsWith("SKILL.md")) {
    throw new Error(`invalid skill filePath: ${filePath}`);
  }
  const skillDir = path.dirname(filePath);
  const userRoot = path.join(os.homedir(), ".code-shell", "skills");
  const looksUserOwned =
    skillDir.startsWith(userRoot + path.sep) ||
    skillDir.includes(`${path.sep}.code-shell${path.sep}skills${path.sep}`);
  if (!looksUserOwned) {
    throw new Error(`refuse to delete: ${skillDir} is outside known skill roots`);
  }
  // Walk-up guard: never let `..` escape its root.
  if (skillDir.includes("..")) {
    throw new Error(`refuse to delete: suspicious path ${skillDir}`);
  }
  await fs.rm(skillDir, { recursive: true, force: true });
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
  const root = scope === "user"
    ? path.join(os.homedir(), ".code-shell", "skills")
    : projectSkillRoot(cwd);
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

  return {
    name,
    targetDir,
    filePath: path.join(targetDir, "SKILL.md"),
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
