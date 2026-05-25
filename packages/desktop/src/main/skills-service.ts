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

import { scanSkills, type SkillDefinition } from "@cjhyy/code-shell-core";
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
  return fs.readFile(filePath, "utf8");
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
