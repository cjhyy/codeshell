import { existsSync } from "node:fs";
import { readdir, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Map a Codex plugin's slash commands into CC's `commands/` layout.
 *
 * Codex `prompts/*.md` and CC `commands/*.md` are isomorphic: each is a
 * markdown file (optional `description`/`argument-hint` frontmatter) whose
 * basename becomes the command name, and codeshell's `pluginCommandsLoader`
 * already scans `commands/*.md`. So the conversion is a flat copy of every
 * `.md` from `prompts/` (and any explicit `commands/`) into `dest/commands/`.
 *
 * Placeholder syntax differs (Codex `$1`/`$FILE` vs CC `$ARGUMENTS`) but the
 * body is copied verbatim — v1 inert, the same stance taken for `codex_`
 * agent fields (see convertAgents.ts). Non-`.md` files are ignored, matching
 * Codex's own behaviour. On a filename collision an explicit `commands/`
 * entry wins over `prompts/` (the more specific source).
 *
 * Async fs throughout: this runs in the Electron main process during install;
 * sync copies block the event loop and freeze the UI (see convertSkills.ts).
 */
export async function copyCodexCommands(sourceDir: string, destDir: string): Promise<void> {
  // prompts/ first, then commands/ — later writes overwrite earlier, so an
  // explicit commands/ entry wins the collision.
  const written = await copyMdFiles(join(sourceDir, "prompts"), join(destDir, "commands"));
  await copyMdFiles(join(sourceDir, "commands"), join(destDir, "commands"), written);
}

/** Flat-copy *.md from srcDir into destDir; returns the set of basenames written. */
async function copyMdFiles(
  srcDir: string,
  destDir: string,
  written: Set<string> = new Set(),
): Promise<Set<string>> {
  if (!existsSync(srcDir)) return written;
  let ensuredDest = false;
  for (const dirent of await readdir(srcDir, { withFileTypes: true })) {
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!dirent.name.endsWith(".md")) continue;
    if (!ensuredDest) {
      await mkdir(destDir, { recursive: true });
      ensuredDest = true;
    }
    await copyFile(join(srcDir, dirent.name), join(destDir, dirent.name));
    written.add(dirent.name);
  }
  return written;
}
