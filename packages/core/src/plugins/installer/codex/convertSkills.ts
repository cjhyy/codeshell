import { existsSync } from "node:fs";
import { cp, lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { PluginInstallError } from "../types.js";

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---/;

/**
 * Copy <sourceDir>/skills into <destDir>/skills verbatim (Codex & CC SKILL.md
 * are isomorphic). Validates each SKILL.md has a frontmatter block first — a
 * malformed skill fails the whole install (spec §10).
 *
 * Async fs throughout: this runs inside the Electron main process during
 * install; a synchronous recursive copy (cpSync) blocks the event loop and
 * freezes the UI. The sibling `cc` branch already awaits cp for this reason
 * (see install.ts) — this mirrors the 178abc8 sync→async migration that
 * originally missed this function.
 */
export async function copyCodexSkills(sourceDir: string, destDir: string): Promise<void> {
  const skillsSrc = join(sourceDir, "skills");
  if (!existsSync(skillsSrc)) return;
  if ((await lstat(skillsSrc)).isSymbolicLink()) {
    throw new PluginInstallError("skills directory must not be a symbolic link");
  }
  const sourceRoot = await realpath(sourceDir);
  const resolvedSkillsRoot = await resolveContainedSkillSource(sourceRoot, skillsSrc, "skills");
  await assertNoSkillSymlinks(resolvedSkillsRoot, resolvedSkillsRoot);

  for (const dirent of await readdir(resolvedSkillsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const skillDir = await resolveContainedSkillSource(
      resolvedSkillsRoot,
      join(resolvedSkillsRoot, dirent.name),
      `skills/${dirent.name}`,
    );
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const resolvedSkillFile = await resolveContainedSkillSource(
      skillDir,
      skillFile,
      `skills/${dirent.name}/SKILL.md`,
    );
    if (!(await stat(resolvedSkillFile)).isFile()) continue;
    const raw = (await readFile(resolvedSkillFile, "utf-8")).trim();
    if (!FRONTMATTER.test(raw)) {
      throw new PluginInstallError(`skills/${dirent.name}/SKILL.md: missing frontmatter`);
    }
  }
  await cp(resolvedSkillsRoot, join(destDir, "skills"), { recursive: true });
}

async function resolveContainedSkillSource(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new PluginInstallError(`skill source not found: ${label}`);
  }
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginInstallError(`skill source escapes plugin dir: ${label}`);
  }
  return target;
}

async function assertNoSkillSymlinks(root: string, dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (entry.isSymbolicLink()) {
      throw new PluginInstallError(`skill source must not contain symbolic links: skills/${rel}`);
    }
    if (entry.isDirectory()) await assertNoSkillSymlinks(root, path);
  }
}
