/**
 * Read-only enumeration of installed plugins for the 扩展 (extensions) settings UI.
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
 * throw — the extensions page should still render if a single entry's
 * installPath has disappeared.
 */

import {
  invalidateSkillCache,
  loadPluginCatalog,
  describePluginContent,
  listPluginMcpTrust,
  PluginInstallError,
  type PluginContentInventory,
  type PluginCatalogEntry,
  type PluginMcpTrustEntry,
} from "@cjhyy/code-shell-core";
import {
  installPlugin,
  refreshMarketplace,
  uninstallPlugin,
  uninstallPluginByName,
  updatePluginByName,
  checkPluginUpdate,
  type UpdateResult,
  type UpdateCheck,
} from "@cjhyy/code-shell-core/internal";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { normalizePluginDisplayMetadata } from "./plugin-display-metadata.js";
import { pluginMediaAvailability } from "./plugin-media-service.js";
import type { PluginMediaAvailability } from "../shared/plugin-media.js";

export interface PluginSummary {
  /** Display name (without the `@marketplace` suffix). */
  name: string;
  /** Author-provided marketplace/install surface name. */
  displayName: string;
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
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  defaultPrompt?: string[];
  brandColor?: string;
  mediaAvailability: PluginMediaAvailability;
}

interface PluginManifest {
  description?: string;
  name?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    longDescription?: string;
    developerName?: string;
    category?: string;
    capabilities?: string[];
    websiteURL?: string;
    privacyPolicyURL?: string;
    termsOfServiceURL?: string;
    defaultPrompt?: string[];
    brandColor?: string;
  };
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
    const metadata = normalizePluginDisplayMetadata(name, manifest);

    out.push({
      name,
      ...metadata,
      mediaAvailability: pluginMediaAvailability(plugin.manifest?.interface),
      installKey,
      marketplace,
      sourceLabel: deriveSourceLabel(marketplace),
      installPath,
      installedAt: plugin.installedAt,
      version: plugin.version,
      skillCount: countSkills(installPath),
    });
  }
  return out;
}

/** Full inventory for the plugin detail view (feedback#15: 看不到插件里有啥). */
export interface PluginDetail extends PluginSummary {
  content: PluginContentInventory;
  mcpTrust?: PluginMcpTrustEntry;
}

export function getPluginDetail(installKey: string): PluginDetail | null {
  const summary = listPlugins("").find((p) => p.installKey === installKey);
  if (!summary) return null;
  const described = summary.installPath
    ? describePluginContent(summary.name, summary.installPath, summary.installKey)
    : {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        automationTemplates: [],
      };
  const mcpTrust = listPluginMcpTrust().find((entry) => entry.installKey === installKey);
  return { ...summary, content: described, ...(mcpTrust ? { mcpTrust } : {}) };
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

type PluginUpdateCatalogEntry = Pick<PluginCatalogEntry, "installKey" | "name" | "marketplace">;

interface PluginUpdateServices {
  listCatalog(): PluginUpdateCatalogEntry[];
  updateLocal(name: string, installedAt: string, force: boolean): Promise<UpdateResult>;
  refreshMarket(name: string): Promise<{ ok: boolean; error?: string }>;
  installFromMarket(
    pluginName: string,
    marketplaceName: string,
  ): Promise<{ ok: boolean; error?: string }>;
  invalidateSkills(): void;
  now(): string;
}

const defaultPluginUpdateServices: PluginUpdateServices = {
  listCatalog: () => loadPluginCatalog(),
  updateLocal: updatePluginByName,
  refreshMarket: refreshMarketplace,
  installFromMarket: installPlugin,
  invalidateSkills: invalidateSkillCache,
  now: () => new Date().toISOString(),
};

function resolvePluginUpdateEntry(
  identity: string,
  catalog: PluginUpdateCatalogEntry[],
): PluginUpdateCatalogEntry {
  const exact = catalog.find((plugin) => plugin.installKey === identity);
  if (exact) return exact;

  // Backward compatibility for a renderer from before update-by-installKey.
  // A bare name is safe only when it identifies exactly one installed source.
  const matchingNames = catalog.filter((plugin) => plugin.name === identity);
  if (matchingNames.length === 1) return matchingNames[0]!;
  if (matchingNames.length > 1) {
    throw new PluginInstallError(
      `multiple installed plugins are named '${identity}'; update by install key instead`,
    );
  }
  throw new PluginInstallError(`no installed plugin named '${identity}'`);
}

/**
 * Re-install one exact installed plugin (the manual "update" button).
 *
 * Local/direct installs update from their recorded source. Marketplace
 * installs have no `~/.code-shell/plugins/<name>/.cs-meta.json`; refresh their
 * marketplace clone and materialize the same `<plugin>@<marketplace>` entry
 * instead. The install key keeps same-name plugins from different sources
 * unambiguous, while the bare-name fallback supports an older renderer.
 */
export async function updatePluginEntry(
  identity: string,
  services: PluginUpdateServices = defaultPluginUpdateServices,
): Promise<UpdateResult> {
  if (typeof identity !== "string" || !identity) {
    throw new Error("updatePluginEntry requires an install key");
  }
  const plugin = resolvePluginUpdateEntry(identity, services.listCatalog());
  if (!plugin.marketplace || plugin.marketplace === "local") {
    return services.updateLocal(plugin.name, services.now(), true);
  }

  const refreshed = await services.refreshMarket(plugin.marketplace);
  if (!refreshed.ok) {
    throw new PluginInstallError(
      `could not refresh marketplace '${plugin.marketplace}': ${refreshed.error ?? "unknown error"}`,
    );
  }
  const installed = await services.installFromMarket(plugin.name, plugin.marketplace);
  if (!installed.ok) {
    throw new PluginInstallError(
      `could not update '${plugin.name}' from marketplace '${plugin.marketplace}': ${installed.error ?? "unknown error"}`,
    );
  }
  services.invalidateSkills();
  return {
    updated: true,
    reason: `refreshed ${plugin.marketplace} and reinstalled ${plugin.name}`,
  };
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
