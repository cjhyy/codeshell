/** Minimal shape needed from PluginSummary to decide uninstall. */
export interface UninstallablePlugin {
  name: string;
  installKey: string;
  marketplace: string | null;
}

export type UninstallTarget =
  | { uninstallable: false }
  | { uninstallable: true; pluginName: string; marketplaceName: string };

/**
 * core's uninstallPlugin(pluginName, marketplaceName) requires a marketplace.
 * Plugins installed locally or via direct GitHub (marketplace === null) have
 * no marketplace key and cannot be uninstalled through this path.
 */
export function resolveUninstallTarget(p: UninstallablePlugin): UninstallTarget {
  if (!p.marketplace) return { uninstallable: false };
  const at = p.installKey.lastIndexOf("@");
  const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
  const marketplaceName = at > 0 ? p.installKey.slice(at + 1) : p.marketplace;
  return { uninstallable: true, pluginName, marketplaceName };
}
