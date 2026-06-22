/** Minimal shape needed from PluginSummary to decide uninstall. */
export interface UninstallablePlugin {
  name: string;
  installKey: string;
  marketplace: string | null;
}

export type UninstallTarget =
  | { uninstallable: false }
  | { uninstallable: true; kind: "marketplace"; pluginName: string; marketplaceName: string }
  | { uninstallable: true; kind: "local"; pluginName: string };

/**
 * Decide how a plugin is uninstalled.
 *
 * Marketplace plugins go through core's uninstallPlugin(pluginName,
 * marketplaceName) — both halves come from splitting the install key
 * `name@marketplace`.
 *
 * Plugins installed locally or via direct GitHub have `marketplace === null`.
 * Their install key is `name@local` (or just the bare name), and core's
 * uninstallPluginByName(name) handles them — so they ARE uninstallable, just
 * via a different path (kind: "local").
 */
export function resolveUninstallTarget(p: UninstallablePlugin): UninstallTarget {
  const at = p.installKey.lastIndexOf("@");
  if (!p.marketplace) {
    // `name@local` → strip the suffix; otherwise the key is the bare name.
    const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
    return { uninstallable: true, kind: "local", pluginName };
  }
  const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
  const marketplaceName = at > 0 ? p.installKey.slice(at + 1) : p.marketplace;
  return { uninstallable: true, kind: "marketplace", pluginName, marketplaceName };
}
