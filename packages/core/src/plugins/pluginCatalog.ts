import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { readInstalledPlugins } from "./installedPlugins.js";
import { assertSafePluginName, pluginsRoot } from "./installer/paths.js";
import {
  CANONICAL_PLUGIN_MANIFEST_FILE,
  CanonicalPluginManifest,
  type PluginAutomationTemplate,
  type CanonicalPluginManifest as CanonicalPluginManifestData,
} from "./installer/types.js";
import { resolveSafePluginPath } from "./pluginInstaller.js";
import type { InstalledPluginsV2 } from "./types.js";

const MAX_CANONICAL_MANIFEST_BYTES = 4 * 1024 * 1024;

/** Core-owned, trusted view of one installed plugin. */
export interface PluginCatalogEntry {
  installKey: string;
  name: string;
  marketplace: string | null;
  /** Validated install layout, independent of marketplace names such as "local". */
  installationKind: "marketplace" | "direct" | "unknown";
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  manifest: CanonicalPluginManifestData | null;
  /** Reusable scheduled-task templates. They never instantiate during install. */
  automationTemplates: readonly PluginAutomationTemplate[];
}

export interface LoadPluginCatalogOptions {
  /** Override points make the loader reusable by isolated hosts and deterministic tests. */
  root?: string;
  installed?: InstalledPluginsV2;
}

export interface PluginAutomationTemplateContribution {
  kind: "automation-template";
  installKey: string;
  pluginName: string;
  marketplace: string | null;
  installPath: string;
  pluginVersion?: string;
  revision: string;
  template: PluginAutomationTemplate;
}

/**
 * Stable content revision used to bind a user review to the exact template
 * instantiated later. Install paths and timestamps are intentionally excluded.
 */
export function pluginAutomationTemplateRevision(
  installKey: string,
  template: PluginAutomationTemplate,
): string {
  return createHash("sha256")
    .update("codeshell-plugin-automation-template-v1")
    .update("\0")
    .update(installKey)
    .update("\0")
    .update(JSON.stringify(template))
    .digest("hex");
}

/**
 * Read an installed plugin manifest without following links or accepting an
 * unbounded/non-regular file. Shared by the runtime catalog and UI inventory so
 * those views cannot disagree about which manifest bytes are trusted.
 */
export function readCatalogPluginManifest(installPath: string): CanonicalPluginManifestData | null {
  const file = join(installPath, CANONICAL_PLUGIN_MANIFEST_FILE);
  let descriptor: number | undefined;
  try {
    const metadata = lstatSync(file);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_CANONICAL_MANIFEST_BYTES
    ) {
      return null;
    }
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_CANONICAL_MANIFEST_BYTES) return null;
    return CanonicalPluginManifest.parse(JSON.parse(readFileSync(descriptor, "utf-8")));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function identityFromInstallKey(
  installKey: string,
  manifest: CanonicalPluginManifestData | null,
): { name: string; marketplace: string | null } {
  const at = installKey.lastIndexOf("@");
  if (at > 0 && at < installKey.length - 1) {
    return { name: installKey.slice(0, at), marketplace: installKey.slice(at + 1) };
  }
  return { name: manifest?.name ?? installKey, marketplace: null };
}

/** Existing registries predate origin metadata. Match the actual writer layouts,
 * never a reserved marketplace name or a user-provided manifest/source label.
 * Paths have already passed the same realpath containment as the inventory.
 */
function installationKind(
  root: string,
  installKey: string,
  installPath: string,
  identity: { name: string; marketplace: string | null },
  version: string,
): PluginCatalogEntry["installationKind"] {
  const { name, marketplace } = identity;
  if (installKey !== (marketplace === null ? name : `${name}@${marketplace}`)) return "unknown";
  if (marketplace === null && name.includes("@")) return "unknown";
  try {
    assertSafePluginName(name);
    if (marketplace !== null) assertSafePluginName(marketplace);
    assertSafePluginName(version);
  } catch {
    return "unknown";
  }
  const parts = relative(root, installPath).split(sep);
  if (parts.length === 1 && parts[0] === name && (!marketplace || marketplace === "local")) {
    return "direct";
  }
  if (
    marketplace &&
    parts.length === 4 &&
    parts[0] === "cache" &&
    parts[1] === marketplace &&
    parts[2] === name &&
    parts[3] === version
  ) {
    return "marketplace";
  }
  return "unknown";
}

/**
 * Load the installed plugin catalog at the core boundary.
 *
 * Installed state is user-writable, so paths are realpath-contained before any
 * manifest is exposed. Multiple scope rows for one install key collapse to the
 * first safe entry, matching the current single-user-scope runtime contract.
 * Conflicting safe origins remain visible but cannot select a destructive route.
 */
export function loadPluginCatalog(options: LoadPluginCatalogOptions = {}): PluginCatalogEntry[] {
  const root = options.root ?? pluginsRoot();
  const installed = options.installed ?? readInstalledPlugins();
  const catalog: PluginCatalogEntry[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return catalog;
  }

  for (const installKey of Object.keys(installed.plugins).sort()) {
    const keyIdentity = identityFromInstallKey(installKey, null);
    const rows = (installed.plugins[installKey] ?? []).flatMap((entry) => {
      const installPath = resolveSafePluginPath(entry.installPath, root);
      if (!installPath) return [];
      return [
        {
          entry,
          installPath,
          installationKind: installationKind(
            canonicalRoot,
            installKey,
            installPath,
            keyIdentity,
            entry.version,
          ),
        },
      ];
    });
    const first = rows[0];
    if (!first) continue;
    const kinds = new Set(rows.map((row) => row.installationKind));
    const manifest = readCatalogPluginManifest(first.installPath);
    const identity = identityFromInstallKey(installKey, manifest);
    catalog.push({
      installKey,
      ...identity,
      installationKind:
        kinds.size === 1 && identity.name === keyIdentity.name ? first.installationKind : "unknown",
      installPath: first.installPath,
      version: first.entry.version,
      installedAt: first.entry.installedAt,
      lastUpdated: first.entry.lastUpdated,
      manifest,
      automationTemplates: manifest?.automations?.templates ?? [],
    });
  }

  return catalog;
}

/** Load reusable automation templates without creating or enabling any jobs. */
export function loadPluginAutomationTemplateContributions(
  options: LoadPluginCatalogOptions = {},
): PluginAutomationTemplateContribution[] {
  return loadPluginCatalog(options).flatMap((plugin) =>
    plugin.automationTemplates.map((template) => ({
      kind: "automation-template" as const,
      installKey: plugin.installKey,
      pluginName: plugin.name,
      marketplace: plugin.marketplace,
      installPath: plugin.installPath,
      ...(plugin.manifest?.version ? { pluginVersion: plugin.manifest.version } : {}),
      revision: pluginAutomationTemplateRevision(plugin.installKey, template),
      template,
    })),
  );
}
