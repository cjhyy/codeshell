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
 * Plugins installed locally carry the marketplace tag "local" — their install
 * key is `name@local`, so listPlugins splits it to marketplace === "local"
 * (NOT null). A bare name with no "@" is also local. core's
 * uninstallPluginByName(name) removes the real ~/.code-shell/plugins/<name> dir
 * (kind: "local"). The earlier `!p.marketplace` check missed the "local" string
 * — truthy — so it wrongly routed to the marketplace path, whose uninstall
 * targets the cache dir and left the real local dir intact (the "uninstall did
 * nothing, reinstall says already-installed" bug).
 */
export function resolveUninstallTarget(p: UninstallablePlugin): UninstallTarget {
  const at = p.installKey.lastIndexOf("@");
  if (!p.marketplace || p.marketplace === "local") {
    // `name@local` → strip the suffix; otherwise the key is the bare name.
    const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
    return { uninstallable: true, kind: "local", pluginName };
  }
  const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
  const marketplaceName = at > 0 ? p.installKey.slice(at + 1) : p.marketplace;
  return { uninstallable: true, kind: "marketplace", pluginName, marketplaceName };
}
