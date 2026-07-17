import { readInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import { readPluginMcp } from "./installer/loadPluginMcp.js";
import {
  pluginMcpApprovalState,
  pluginMcpDigest,
  type PluginMcpApprovalState,
} from "./pluginMcpIntegrity.js";
import type { InstalledPluginsV2, PluginInstallEntry } from "./types.js";

export interface PluginMcpTrustEntry {
  installKey: string;
  plugin: string;
  serverNames: string[];
  status: PluginMcpApprovalState;
}

export interface PluginMcpApprovalResult extends PluginMcpTrustEntry {
  changed: boolean;
}

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

function matchingInstallKeys(data: InstalledPluginsV2, target: string): string[] {
  if (!target.trim()) throw new Error("plugin MCP approval requires a plugin name or install key");
  if (data.plugins[target]) return [target];
  const matches = Object.keys(data.plugins).filter((key) => pluginNameFromKey(key) === target);
  if (matches.length === 0) throw new Error(`plugin "${target}" is not installed`);
  if (matches.length > 1) {
    throw new Error(`plugin "${target}" has multiple installs; use one of: ${matches.join(", ")}`);
  }
  return matches;
}

function trustEntry(
  installKey: string,
  entry: PluginInstallEntry,
  changed?: boolean,
): PluginMcpTrustEntry | PluginMcpApprovalResult {
  const plugin = pluginNameFromKey(installKey);
  const serverNames = Object.keys(readPluginMcp(entry.installPath, plugin))
    .map((name) => name.slice(plugin.length + 1))
    .sort();
  const base: PluginMcpTrustEntry = {
    installKey,
    plugin,
    serverNames,
    status: pluginMcpApprovalState(entry, serverNames.length > 0),
  };
  return changed === undefined ? base : { ...base, changed };
}

/** List every installed plugin's MCP trust without merging user MCP config. */
export function listPluginMcpTrust(): PluginMcpTrustEntry[] {
  const data = readInstalledPlugins();
  const out: PluginMcpTrustEntry[] = [];
  for (const [installKey, entries] of Object.entries(data.plugins)) {
    for (const entry of entries) {
      out.push(trustEntry(installKey, entry) as PluginMcpTrustEntry);
    }
  }
  return out.sort((a, b) => a.installKey.localeCompare(b.installKey));
}

/** Approve only the install-time MCP bytes; tampered bytes require update/reinstall. */
export function approvePluginMcp(target: string): PluginMcpApprovalResult[] {
  const data = readInstalledPlugins();
  const keys = matchingInstallKeys(data, target);
  const out: PluginMcpApprovalResult[] = [];
  let writeNeeded = false;

  for (const installKey of keys) {
    for (const entry of data.plugins[installKey] ?? []) {
      let entryChanged = false;
      const currentDigest = pluginMcpDigest(entry.installPath);
      if (entry.mcpDigest && currentDigest !== entry.mcpDigest) {
        throw new Error(
          `plugin "${installKey}" MCP config changed after install; reinstall or update before approving`,
        );
      }
      if (!entry.mcpDigest) {
        entry.mcpDigest = currentDigest;
        entryChanged = true;
      }
      if (entry.approvedMcpDigest !== entry.mcpDigest) {
        entry.approvedMcpDigest = entry.mcpDigest;
        entryChanged = true;
      }
      writeNeeded ||= entryChanged;
      out.push(trustEntry(installKey, entry, entryChanged) as PluginMcpApprovalResult);
    }
  }

  if (writeNeeded) writeInstalledPlugins(data);
  return out;
}

/**
 * Revoke plugin MCP execution. Legacy entries first record their current
 * digest, preventing revocation from falling back to legacy compatibility.
 */
export function revokePluginMcp(target: string): PluginMcpApprovalResult[] {
  const data = readInstalledPlugins();
  const keys = matchingInstallKeys(data, target);
  const out: PluginMcpApprovalResult[] = [];
  let writeNeeded = false;

  for (const installKey of keys) {
    const plugin = pluginNameFromKey(installKey);
    for (const entry of data.plugins[installKey] ?? []) {
      let entryChanged = false;
      const hasServers = Object.keys(readPluginMcp(entry.installPath, plugin)).length > 0;
      const currentDigest = pluginMcpDigest(entry.installPath);
      if (!entry.mcpDigest) {
        entry.mcpDigest = currentDigest;
        entryChanged = true;
      }
      if (hasServers || currentDigest !== entry.mcpDigest) {
        if (entry.approvedMcpDigest !== undefined) {
          delete entry.approvedMcpDigest;
          entryChanged = true;
        }
      } else if (entry.approvedMcpDigest !== entry.mcpDigest) {
        entry.approvedMcpDigest = entry.mcpDigest;
        entryChanged = true;
      }
      writeNeeded ||= entryChanged;
      out.push(trustEntry(installKey, entry, entryChanged) as PluginMcpApprovalResult);
    }
  }

  if (writeNeeded) writeInstalledPlugins(data);
  return out;
}
