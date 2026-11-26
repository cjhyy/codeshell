import { mutateInstalledPlugins, readInstalledPlugins } from "./installedPlugins.js";
import { matchingInstallKeys, pluginNameFromKey } from "./pluginHookApproval.js";
import { readPluginMcp } from "./installer/loadPluginMcp.js";
import {
  pluginMcpApprovalState,
  pluginMcpDigest,
  type PluginMcpApprovalState,
} from "./pluginMcpIntegrity.js";
import { approvePluginContent } from "./pluginTreeDigest.js";
import type { PluginInstallEntry } from "./types.js";

export interface PluginMcpTrustEntry {
  installKey: string;
  plugin: string;
  serverNames: string[];
  status: PluginMcpApprovalState;
}

export interface PluginMcpApprovalResult extends PluginMcpTrustEntry {
  changed: boolean;
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

/**
 * Approve one install entry's MCP servers in place: only the install-time
 * declaration and, when it declares runnable servers, the whole install tree.
 * Tampered bytes require update/reinstall. A record that predates either
 * digest is completed from what is on disk now. Returns whether it changed.
 */
export function approveMcpEntry(
  installKey: string,
  plugin: string,
  entry: PluginInstallEntry,
): boolean {
  const currentDigest = pluginMcpDigest(entry.installPath);
  if (entry.mcpDigest && currentDigest !== entry.mcpDigest) {
    throw new Error(
      `plugin "${installKey}" MCP config changed after install; reinstall or update before approving`,
    );
  }
  let changed =
    Object.keys(readPluginMcp(entry.installPath, plugin)).length > 0
      ? approvePluginContent(installKey, entry)
      : false;
  if (!entry.mcpDigest) {
    entry.mcpDigest = currentDigest;
    changed = true;
  }
  if (entry.approvedMcpDigest !== entry.mcpDigest) {
    entry.approvedMcpDigest = entry.mcpDigest;
    changed = true;
  }
  return changed;
}

/**
 * Revoke one install entry's MCP servers in place. The content approval is
 * left alone: it is shared with the plugin's other executable kinds, and
 * without an MCP approval it connects nothing. Returns whether it changed.
 */
export function revokeMcpEntry(plugin: string, entry: PluginInstallEntry): boolean {
  let changed = false;
  const hasServers = Object.keys(readPluginMcp(entry.installPath, plugin)).length > 0;
  const currentDigest = pluginMcpDigest(entry.installPath);
  if (!entry.mcpDigest) {
    entry.mcpDigest = currentDigest;
    changed = true;
  }
  if (hasServers || currentDigest !== entry.mcpDigest) {
    if (entry.approvedMcpDigest !== undefined) {
      delete entry.approvedMcpDigest;
      changed = true;
    }
  } else if (entry.approvedMcpDigest !== entry.mcpDigest) {
    entry.approvedMcpDigest = entry.mcpDigest;
    changed = true;
  }
  return changed;
}

function mutateMcpTrust(
  target: string,
  beforeCommit: (() => void) | undefined,
  apply: (installKey: string, plugin: string, entry: PluginInstallEntry) => boolean,
): PluginMcpApprovalResult[] {
  return (
    mutateInstalledPlugins((data) => {
      const out: PluginMcpApprovalResult[] = [];
      let writeNeeded = false;
      for (const installKey of matchingInstallKeys(data, target, "plugin MCP approval")) {
        const plugin = pluginNameFromKey(installKey);
        for (const entry of data.plugins[installKey] ?? []) {
          const entryChanged = apply(installKey, plugin, entry);
          writeNeeded ||= entryChanged;
          out.push(trustEntry(installKey, entry, entryChanged) as PluginMcpApprovalResult);
        }
      }
      if (writeNeeded) beforeCommit?.();
      return { ...(writeNeeded ? { value: data } : {}), result: out };
    }) ?? []
  );
}

/** Approve the MCP servers of every install entry the target names. */
export function approvePluginMcp(
  target: string,
  beforeCommit?: () => void,
): PluginMcpApprovalResult[] {
  return mutateMcpTrust(target, beforeCommit, approveMcpEntry);
}

/** Revoke MCP execution for every install entry the target names. */
export function revokePluginMcp(
  target: string,
  beforeCommit?: () => void,
): PluginMcpApprovalResult[] {
  return mutateMcpTrust(target, beforeCommit, (_installKey, plugin, entry) =>
    revokeMcpEntry(plugin, entry),
  );
}
