/**
 * Read-only enumeration of installed plugins for the Customize UI.
 *
 * Sourced from core's trusted plugin catalog (the same installed state the
 * runtime uses). For each install key (`<plugin>@<marketplace>`) we derive a
 * source label and a skill count by counting
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
  loadPluginCatalog,
  loadPluginPanelContributions,
  uninstallPlugin,
  uninstallPluginByName,
  updatePluginByName,
  checkPluginUpdate,
  describePluginContent,
  type PluginContentInventory,
  type UpdateResult,
  type UpdateCheck,
  SettingsManager,
} from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  PluginPanelDescriptor,
  PluginPanelExtensionSummary,
} from "../shared/plugin-panels.js";
import {
  replacePluginPanelResources,
  type PluginPanelProtocolResource,
} from "./plugin-panel-protocol.js";

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

function readLegacyPluginManifest(installPath: string): PluginManifest | null {
  const candidates = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "plugin.json",
    "claude-plugin.json",
  ];
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

function panelTitle(
  title: { default: string; en?: string; "zh-CN"?: string },
  locale: string,
): string {
  return locale.toLowerCase().startsWith("zh")
    ? (title["zh-CN"] ?? title.default)
    : (title.en ?? title.default);
}

function installedPanelRevision(installPath: string, entry: string): string {
  const hash = createHash("sha256");
  for (const relative of [".cs-meta.json", ".cs-plugin-manifest.json", entry]) {
    const file = path.join(installPath, relative);
    try {
      const stat = statSync(file);
      hash.update(relative).update("\0").update(String(stat.size)).update("\0");
      if (relative.endsWith(".json")) hash.update(readFileSync(file));
      else hash.update(String(stat.mtimeMs));
    } catch {
      hash.update(relative).update("\0missing\0");
    }
  }
  return hash.digest("hex");
}

function discoverPluginPanels(locale: string): {
  descriptors: PluginPanelDescriptor[];
  resources: PluginPanelProtocolResource[];
} {
  let panels: ReturnType<typeof loadPluginPanelContributions>;
  try {
    panels = loadPluginPanelContributions();
  } catch {
    return { descriptors: [], resources: [] };
  }

  const descriptors: PluginPanelDescriptor[] = [];
  const resources: PluginPanelProtocolResource[] = [];
  for (const contribution of panels) {
    const { installKey: key, installPath, pluginName, panel } = contribution;
    const revision = installedPanelRevision(installPath, panel.entry);
    const hostSeed = createHash("sha256")
      .update(key)
      .update("\0")
      .update(installPath)
      .update("\0")
      .update(JSON.stringify(panel))
      .update("\0")
      .update(revision)
      .digest("hex");
    // One authority/partition per panel is stricter than sharing a plugin
    // origin: sibling panels cannot navigate into each other's entry trees.
    const hostId = createHash("sha256")
      .update(hostSeed)
      .update("\0")
      .update(panel.id)
      .digest("hex")
      .slice(0, 32);
    const descriptor: PluginPanelDescriptor = {
      id: `plugin:${key}:${panel.id}`,
      installKey: key,
      pluginName,
      panelId: panel.id,
      title: panelTitle(panel.title, locale),
      icon: panel.icon,
      singleton: panel.singleton,
      permissions: [...panel.permissions],
      hostId,
      revision,
    };
    descriptors.push(descriptor);
    resources.push({ descriptor, root: installPath, entry: panel.entry });
  }
  return { descriptors, resources };
}

function disabledPluginNames(cwd: string): Set<string> {
  const disabledPlugins = (() => {
    try {
      return computeEffectiveDisabledLists(
        new SettingsManager(cwd || process.cwd(), "full"),
        cwd || undefined,
      ).disabledPlugins;
    } catch {
      return [];
    }
  })();
  return new Set(disabledPlugins);
}

/** Installed UI contributions for the Extensions page, including disabled ones. */
export function listPanelExtensions(cwd: string, locale: string): PluginPanelExtensionSummary[] {
  const disabled = disabledPluginNames(cwd);
  return discoverPluginPanels(locale).descriptors.map((panel) => {
    const disabledByPackage = disabled.has(panel.pluginName);
    return {
      ...panel,
      kind: "panel" as const,
      enabled: !disabledByPackage,
      disabledByPackage,
    };
  });
}

/** Runtime descriptors for the session-owned right dock. */
export function listPluginPanels(cwd: string, locale: string): PluginPanelDescriptor[] {
  const discovered = discoverPluginPanels(locale);
  // Protocol resources represent all installed panels. Per-project disabling
  // only filters descriptors, so two windows with different settings cannot
  // accidentally revoke each other's protocol host.
  replacePluginPanelResources(discovered.resources);
  const disabled = disabledPluginNames(cwd);
  return discovered.descriptors.filter((panel) => !disabled.has(panel.pluginName));
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
  let plugins: ReturnType<typeof loadPluginCatalog>;
  try {
    plugins = loadPluginCatalog();
  } catch {
    return [];
  }

  const out: PluginSummary[] = [];
  for (const plugin of plugins) {
    const { installKey, name, marketplace, installPath } = plugin;
    const manifest = plugin.manifest ?? readLegacyPluginManifest(installPath);

    out.push({
      name,
      installKey,
      marketplace,
      sourceLabel: deriveSourceLabel(marketplace),
      installPath,
      installedAt: plugin.installedAt,
      version: plugin.version,
      skillCount: countSkills(installPath),
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
    : { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], panels: [] };
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
