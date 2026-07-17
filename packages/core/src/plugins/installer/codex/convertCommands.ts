import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PluginInstallError } from "../types.js";

/**
 * Map a Codex plugin's slash commands into CC's `commands/` layout.
 *
 * Codex `prompts/*.md` and CC `commands/*.md` are isomorphic: each is a
 * markdown file (optional `description`/`argument-hint` frontmatter) whose
 * basename becomes the command name, and codeshell's `pluginCommandsLoader`
 * already scans `commands/*.md`. So the conversion is a flat copy of every
 * `.md` from `prompts/` (and any explicit `commands/`) into `dest/commands/`.
 *
 * Placeholder syntax differs (Codex `$1`/`$FILE` vs CC `$ARGUMENTS`), so the
 * body is copied verbatim and expanded at invocation time by
 * `expandPluginCommandBody`. Non-`.md` files are ignored, matching Codex's
 * own behaviour. On a filename collision an explicit `commands/` entry wins
 * over `prompts/` (the more specific source).
 *
 * Async fs throughout: this runs in the Electron main process during install;
 * sync copies block the event loop and freeze the UI (see convertSkills.ts).
 */
export async function copyCodexCommands(sourceDir: string, destDir: string): Promise<void> {
  const sourceRoot = await realpath(sourceDir);
  // prompts/ first, then commands/ — later writes overwrite earlier, so an
  // explicit commands/ entry wins the collision.
  const written = await copyMdFiles(
    sourceRoot,
    join(sourceDir, "prompts"),
    join(destDir, "commands"),
  );
  await copyMdFiles(sourceRoot, join(sourceDir, "commands"), join(destDir, "commands"), written);
}

/** Flat-copy *.md from srcDir into destDir; returns the set of basenames written. */
async function copyMdFiles(
  sourceRoot: string,
  srcDir: string,
  destDir: string,
  written: Set<string> = new Set(),
): Promise<Set<string>> {
  if (!existsSync(srcDir)) return written;
  const resolvedDir = await resolveContainedSource(sourceRoot, srcDir, srcDir);
  let ensuredDest = false;
  for (const dirent of await readdir(resolvedDir, { withFileTypes: true })) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!dirent.name.endsWith(".md")) continue;
    const source = await resolveContainedSource(
      sourceRoot,
      join(resolvedDir, dirent.name),
      `${srcDir}/${dirent.name}`,
    );
    if (!(await stat(source)).isFile()) continue;
    if (!ensuredDest) {
      await mkdir(destDir, { recursive: true });
      ensuredDest = true;
    }
    const destination = join(destDir, dirent.name);
    if (resolve(source) !== resolve(destination)) {
      await copyFile(source, destination);
    }
    written.add(dirent.name);
  }
  return written;
}

async function resolveContainedSource(
  sourceRoot: string,
  candidate: string,
  label: string,
): Promise<string> {
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new PluginInstallError(`plugin command source not found: ${label}`);
  }
  const rel = relative(sourceRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginInstallError(`plugin command source escapes plugin dir: ${label}`);
  }
  return target;
}
