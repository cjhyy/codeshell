/**
 * First-run soft pre-install of core plugins (feedback#22, 决策 A+软预装).
 *
 * After seedDefaults registers the bundled marketplace sources, this installs
 * a short list of CORE plugins (e.g. skill-creator from the official
 * mimi-plugins marketplace) so a fresh install ships with batteries included
 * — without baking the plugins into the app bundle.
 *
 * Contract (user decisions, 2026-06-12):
 *  - Only the listed core plugins are auto-installed, never the whole market.
 *  - Silent retry: a failed install (offline first launch) writes NO marker,
 *    so the next startup tries again; never blocks startup, never dialogs.
 *  - Install-once: success writes a marker; we never reinstall or update
 *    automatically afterward, so user edits/uninstalls are respected.
 *  - All fs here is the marker file (tiny, async); the heavy clone work in
 *    installPlugin is git/network-bound and runs detached from startup.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { installPlugin, readInstalledPlugins, pluginInstallKey } from "@cjhyy/code-shell-core";

export interface CorePlugin {
  plugin: string;
  marketplace: string;
}

/** Core plugins every fresh install gets (keep this list short). */
export const CORE_PLUGINS: CorePlugin[] = [
  { plugin: "skill-creator", marketplace: "mimi-plugins" },
];

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function markerPath(home: string): string {
  return join(home, ".code-shell", "plugins", "core_plugins_installed.json");
}

/**
 * Pure decision: which core plugins still need an install attempt.
 * Skips entries already marked installed-by-us AND entries the user already
 * has (installed manually, or left over after they edited the install) —
 * "already installed" also writes the marker so we stop re-checking.
 */
export function pluginsNeedingInstall(
  core: CorePlugin[],
  marker: Record<string, string>,
  installedKeys: string[],
): { toInstall: CorePlugin[]; alreadyInstalled: CorePlugin[] } {
  const installed = new Set(installedKeys);
  const toInstall: CorePlugin[] = [];
  const alreadyInstalled: CorePlugin[] = [];
  for (const cp of core) {
    const key = pluginInstallKey(cp.plugin, cp.marketplace);
    if (marker[key]) continue;
    if (installed.has(key)) alreadyInstalled.push(cp);
    else toInstall.push(cp);
  }
  return { toInstall, alreadyInstalled };
}

async function readMarker(home: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(markerPath(home), "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function writeMarker(home: string, marker: Record<string, string>): Promise<void> {
  const p = markerPath(home);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/**
 * Run the soft pre-install. Best-effort end to end: any error is logged and
 * swallowed (next startup retries whatever didn't get marked).
 */
export async function bootstrapCorePlugins(home: string = userHome()): Promise<void> {
  try {
    const marker = await readMarker(home);
    const installedKeys = Object.keys(readInstalledPlugins().plugins);
    const { toInstall, alreadyInstalled } = pluginsNeedingInstall(
      CORE_PLUGINS,
      marker,
      installedKeys,
    );
    let changed = false;
    for (const cp of alreadyInstalled) {
      // User already has it — record so we never touch it again.
      marker[pluginInstallKey(cp.plugin, cp.marketplace)] = "pre-existing";
      changed = true;
    }
    for (const cp of toInstall) {
      try {
        const res = await installPlugin(cp.plugin, cp.marketplace);
        if (res.ok) {
          marker[pluginInstallKey(cp.plugin, cp.marketplace)] = new Date().toISOString();
          changed = true;
          console.log(`bootstrap: installed core plugin ${cp.plugin}@${cp.marketplace}`);
        } else {
          // No marker → silent retry next launch.
          console.error(`bootstrap: core plugin ${cp.plugin} install failed: ${res.error}`);
        }
      } catch (err) {
        console.error(`bootstrap: core plugin ${cp.plugin} install threw`, err);
      }
    }
    if (changed) await writeMarker(home, marker);
  } catch (err) {
    console.error("bootstrap: core plugins failed", err);
  }
}
