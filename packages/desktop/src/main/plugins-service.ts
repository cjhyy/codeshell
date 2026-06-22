/**
 * Read-only enumeration of installed plugins for the Customize UI.
 *
 * Sourced from core's `readInstalledPlugins()` (the same V2 JSON the
 * scanner uses). For each install key (`<plugin>@<marketplace>`) we
 * derive a display name, a source label and a skill count by counting
 * `installPath/skills/*\/SKILL.md` files on disk — the value isn't
 * authoritative for tool dispatch (the scanner is), it's just for the
 * left-pane summary.
 *
 * Plugin descriptions are read best-effort from `plugin.json` if it
 * exists; missing manifests are not an error. We deliberately never
 * throw — the Customize page should still render if a single entry's
 * installPath has disappeared.
 */

import {
  listInstalled,
  uninstallPlugin,
  uninstallPluginByName,
  updatePluginByName,
  checkPluginUpdate,
  describePluginContent,
  type PluginContentInventory,
  type UpdateResult,
  type UpdateCheck,
} from "@cjhyy/code-shell-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface PluginSummary {
  /** Display name (without the `@marketplace` suffix). */
  name: string;
  /** Full install key from installed-plugins.json (e.g. "superpowers@official"). */
  installKey: string;
  /** Marketplace source — null for direct git / GitHub installs without marketplace. */
  marketplace: string | null;
  /** Source line shown under the plugin name. */
  sourceLabel: string;
  /** Plugin install path (truncated display elsewhere). */
  installPath: string;
  installedAt: string;
  version: string;
  /** Number of skills this plugin contributes (counted from disk). */
  skillCount: number;
  /** Optional plugin description if `plugin.json` provides one. */
  description?: string;
}

interface PluginManifest {
  description?: string;
  name?: string;
}

function readPluginManifest(installPath: string): PluginManifest | null {
  const candidates = ["plugin.json", "claude-plugin.json"];
  for (const file of candidates) {
    const full = path.join(installPath, file);
    if (!existsSync(full)) continue;
    try {
      const raw = JSON.parse(readFileSync(full, "utf-8"));
      if (raw && typeof raw === "object") return raw as PluginManifest;
    } catch {
      // Corrupt manifest — ignore, fall through to the next candidate.
    }
  }
  return null;
}

function countSkills(installPath: string): number {
  const skillsDir = path.join(installPath, "skills");
  if (!existsSync(skillsDir)) return 0;
  let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (existsSync(path.join(skillsDir, e.name, "SKILL.md"))) count++;
  }
  return count;
}

function deriveSourceLabel(marketplace: string | null): string {
  if (!marketplace) return "本地安装";
  return `installed from ${marketplace}`;
}

export function listPlugins(_cwd: string): PluginSummary[] {
  let rows: ReturnType<typeof listInstalled>;
  try {
    rows = listInstalled();
  } catch {
    return [];
  }

  // listInstalled() may include multiple rows per key (different scopes).
  // For the Customize summary we collapse to one per key — keys are
  // unique in the plugins JSON, and the MVP only writes scope:"user".
  const seen = new Set<string>();
  const out: PluginSummary[] = [];
  for (const { key, entry } of rows) {
    if (seen.has(key)) continue;
    seen.add(key);

    const atIdx = key.lastIndexOf("@");
    const name = atIdx > 0 ? key.slice(0, atIdx) : key;
    const marketplace = atIdx > 0 ? key.slice(atIdx + 1) : null;
    const installPath = entry.installPath;
    const manifest = installPath ? readPluginManifest(installPath) : null;

    out.push({
      name,
      installKey: key,
      marketplace,
      sourceLabel: deriveSourceLabel(marketplace),
      installPath,
      installedAt: entry.installedAt,
      version: entry.version,
      skillCount: installPath ? countSkills(installPath) : 0,
      description: manifest?.description,
    });
  }
  return out;
}

/** Full inventory for the plugin detail view (feedback#15: 看不到插件里有啥). */
export interface PluginDetail extends PluginSummary {
  content: PluginContentInventory;
}

export function getPluginDetail(installKey: string): PluginDetail | null {
  const summary = listPlugins("").find((p) => p.installKey === installKey);
  if (!summary) return null;
  const content = summary.installPath
    ? describePluginContent(summary.name, summary.installPath)
    : { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] };
  return { ...summary, content };
}

export interface UninstallPluginResult {
  ok: boolean;
  removedFromManifest: boolean;
  removedFromDisk: boolean;
}

/**
 * Uninstall a marketplace-installed plugin. pluginName/marketplaceName come
 * from the renderer after splitting the install key (see resolveUninstallTarget).
 * Throws on bad input so the IPC layer surfaces a clear error.
 */
export function uninstallPluginEntry(
  pluginName: string,
  marketplaceName: string,
): UninstallPluginResult {
  if (typeof pluginName !== "string" || !pluginName) {
    throw new Error("uninstallPluginEntry requires pluginName");
  }
  if (typeof marketplaceName !== "string" || !marketplaceName) {
    throw new Error("uninstallPluginEntry requires marketplaceName");
  }
  return uninstallPlugin(pluginName, marketplaceName);
}

/**
 * Uninstall a locally-installed (or direct-GitHub) plugin — these have no
 * marketplace key, so core's uninstallPluginByName(name) removes the plugin
 * dir + its `name@local` manifest entry. `name` is the bare plugin name the
 * renderer derives from the install key (see resolveUninstallTarget).
 * Throws on bad input so the IPC layer surfaces a clear error.
 */
export function uninstallLocalPluginEntry(name: string): void {
  if (typeof name !== "string" || !name) {
    throw new Error("uninstallLocalPluginEntry requires a plugin name");
  }
  uninstallPluginByName(name);
}

/**
 * Re-install a plugin from its recorded source (the manual "update" button).
 * `name` is the bare plugin name — the same key `pluginInstallDir` uses, which
 * is what PluginSummary.name carries. Core stamps the install timestamp; we
 * pass `force` so a CC plugin (no version to diff) can be re-pulled on demand.
 * The reinstall is atomic in core — a failed update keeps the old version.
 */
export async function updatePluginEntry(name: string): Promise<UpdateResult> {
  if (typeof name !== "string" || !name) {
    throw new Error("updatePluginEntry requires a plugin name");
  }
  return updatePluginByName(name, new Date().toISOString(), true);
}

/**
 * Check whether a remote (git) plugin has a newer commit upstream. Network
 * round-trip (git ls-remote) — the renderer calls this per-plugin in the
 * background AFTER the list renders, so it never blocks the list. Never throws
 * for the unknown-plugin case the renderer might race into: we return a
 * not-available result so a stale row just shows no badge.
 */
export async function checkPluginUpdateEntry(name: string): Promise<UpdateCheck> {
  if (typeof name !== "string" || !name) {
    return { name: String(name), updateAvailable: false, reason: "missing name" };
  }
  try {
    return await checkPluginUpdate(name);
  } catch (e) {
    return { name, updateAvailable: false, reason: String((e as Error)?.message ?? e) };
  }
}

