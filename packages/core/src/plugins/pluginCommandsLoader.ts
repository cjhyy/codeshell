/**
 * Discover plugin-provided slash commands. For each installed plugin,
 * walks <installPath>/commands/*.md and returns one PluginCommand per
 * markdown file. Mirrors Claude Code's loadPluginCommands.ts at the
 * MVP subset (single-level commands directory, no nested subcommands,
 * no inline-via-plugin.json commands).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { memoize } from "../utils/memoize.js";
import { parseFrontmatter, coerceDescription } from "../skills/frontmatter.js";
import { installedPluginsPath, readInstalledPlugins } from "./installedPlugins.js";

export interface PluginCommand {
  /** Namespaced name, e.g. "superpowers:brainstorming" */
  name: string;
  /** Plain command (without plugin prefix), e.g. "brainstorming" */
  commandName: string;
  /** Plugin id (without @marketplace), e.g. "superpowers" */
  pluginName: string;
  /** Frontmatter description, coerced. May be empty. */
  description: string;
  /** Frontmatter "argument-hint" if present. */
  argumentHint?: string;
  /** Body of the .md (frontmatter stripped). */
  body: string;
  /** Absolute path to the .md file. */
  filePath: string;
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

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function readCommandFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (e) {
    if (isENOENT(e)) return null;
    if (isInaccessible(e)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-commands] cannot read ${filePath}: ${(e as Error).message}`);
      return null;
    }
    throw e;
  }
}

function scanOnce(): PluginCommand[] {
  const data = readInstalledPlugins();
  const out: PluginCommand[] = [];
  const seen = new Set<string>();

  const keys = Object.keys(data.plugins).sort();
  for (const key of keys) {
    const entries = data.plugins[key] ?? [];
    const atIdx = key.lastIndexOf("@");
    const pluginName = atIdx > 0 ? key.slice(0, atIdx) : key;

    for (const entry of entries) {
      const commandsDir = join(entry.installPath, "commands");
      if (!existsSync(commandsDir)) continue;

      let dirEntries;
      try {
        dirEntries = readdirSync(commandsDir, { withFileTypes: true });
      } catch (e) {
        if (isInaccessible(e)) {
          // eslint-disable-next-line no-console
          console.warn(`[plugin-commands] cannot read ${commandsDir}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      for (const dirent of dirEntries) {
        if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
        if (!dirent.name.endsWith(".md")) continue;
        const filePath = join(commandsDir, dirent.name);
        const raw = readCommandFile(filePath);
        if (raw === null) continue;

        const baseName = dirent.name.slice(0, -3); // drop .md
        const namespaced = `${pluginName}:${baseName}`;
        if (seen.has(namespaced)) continue;

        const { frontmatter, body } = parseFrontmatter(raw);
        const description = coerceDescription(frontmatter.description);
        const argumentHint =
          typeof frontmatter["argument-hint"] === "string"
            ? frontmatter["argument-hint"]
            : undefined;

        out.push({
          name: namespaced,
          commandName: baseName,
          pluginName,
          description,
          argumentHint,
          body,
          filePath,
        });
        seen.add(namespaced);
      }
    }
  }
  return out;
}

function installedPluginsMtime(): string {
  const p = installedPluginsPath();
  try {
    return statSync(p).mtimeMs.toString();
  } catch {
    return "0";
  }
}

const memoized = memoize(scanOnce, () => `${userHome()}\0${installedPluginsMtime()}`);

export function scanPluginCommands(): PluginCommand[] {
  return memoized();
}

export function invalidatePluginCommandsCache(): void {
  memoized.cache.clear?.();
}
