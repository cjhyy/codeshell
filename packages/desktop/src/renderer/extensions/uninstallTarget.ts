/** Minimal shape needed from PluginSummary to decide uninstall. */
export interface UninstallablePlugin {
  name: string;
  installKey: string;
  marketplace: string | null;
  installationKind?: "marketplace" | "direct" | "unknown";
}

export type UninstallTarget =
  | { uninstallable: false }
  | { uninstallable: true; kind: "marketplace"; pluginName: string; marketplaceName: string }
  | { uninstallable: true; kind: "local"; pluginName: string };

/** Resolve only the Core-validated source; "local" is a valid marketplace name. */
export function resolveUninstallTarget(p: UninstallablePlugin): UninstallTarget {
  const at = p.installKey.lastIndexOf("@");
  const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
  if (!pluginName) return { uninstallable: false };
  if (p.installationKind === "direct") {
    return { uninstallable: true, kind: "local", pluginName };
  }
  if (p.installationKind === "marketplace" && p.marketplace) {
    const marketplaceName = at > 0 ? p.installKey.slice(at + 1) : p.marketplace;
    if (marketplaceName && marketplaceName === p.marketplace) {
      return { uninstallable: true, kind: "marketplace", pluginName, marketplaceName };
    }
  }
  return { uninstallable: false };
}
