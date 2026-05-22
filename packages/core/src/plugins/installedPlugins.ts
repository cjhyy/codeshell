/**
 * Read/write ~/.code-shell/plugins/installed_plugins.json (V2 format).
 * Byte-compatible with Claude Code's analogous file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { InstalledPluginsV2, PluginInstallEntry } from "./types.js";

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function installedPluginsPath(): string {
  return join(userHome(), ".code-shell", "plugins", "installed_plugins.json");
}

const EMPTY: InstalledPluginsV2 = { version: 2, plugins: {} };

export function readInstalledPlugins(): InstalledPluginsV2 {
  const path = installedPluginsPath();
  if (!existsSync(path)) return { version: 2, plugins: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && raw.version === 2 && raw.plugins && typeof raw.plugins === "object") {
      return raw as InstalledPluginsV2;
    }
  } catch {
    // Corrupt — treat as empty so the user can re-install.
  }
  return { version: 2, plugins: {} };
}

export function writeInstalledPlugins(data: InstalledPluginsV2): void {
  const path = installedPluginsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Append an install entry for `<plugin>@<marketplace>`. Multiple entries
 * for the same key are allowed (different scopes); MVP only writes scope:"user".
 */
export function appendInstallEntry(key: string, entry: PluginInstallEntry): void {
  const data = readInstalledPlugins();
  const list = data.plugins[key] ?? [];
  list.push(entry);
  data.plugins[key] = list;
  writeInstalledPlugins(data);
}

export function removeInstallEntries(key: string): boolean {
  const data = readInstalledPlugins();
  if (!(key in data.plugins)) return false;
  delete data.plugins[key];
  writeInstalledPlugins(data);
  return true;
}

export function pluginInstallKey(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}
