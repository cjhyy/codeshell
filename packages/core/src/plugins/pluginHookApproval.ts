import { readInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import {
  inspectPluginHooks,
  pluginHookReviewSnapshot,
  pluginHookApprovalState,
  type PluginHooksSnapshot,
  type PluginHookApprovalState,
} from "./pluginHookIntegrity.js";
import type { InstalledPluginsV2, PluginInstallEntry, StoredPluginHookReview } from "./types.js";

export interface PluginHookApprovalResult {
  installKey: string;
  plugin: string;
  status: PluginHookApprovalState;
  changed: boolean;
}

export interface PluginHookReviewDiffItem {
  change: "added" | "removed" | "changed" | "unchanged";
  current?: StoredPluginHookReview;
  previous?: StoredPluginHookReview;
}

export interface PluginHookReview {
  installKey: string;
  plugin: string;
  status: PluginHookApprovalState;
  baselineAvailable: boolean;
  items: PluginHookReviewDiffItem[];
  error?: string;
}

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

function matchingInstallKeys(data: InstalledPluginsV2, target: string): string[] {
  if (!target.trim()) throw new Error("plugin hook approval requires a plugin name or install key");
  if (data.plugins[target]) return [target];
  const matches = Object.keys(data.plugins).filter((key) => pluginNameFromKey(key) === target);
  if (matches.length === 0) throw new Error(`plugin "${target}" is not installed`);
  if (matches.length > 1) {
    throw new Error(`plugin "${target}" has multiple installs; use one of: ${matches.join(", ")}`);
  }
  return matches;
}

function result(
  installKey: string,
  entry: PluginInstallEntry,
  changed: boolean,
  snapshot: PluginHooksSnapshot,
): PluginHookApprovalResult {
  return {
    installKey,
    plugin: pluginNameFromKey(installKey),
    status: pluginHookApprovalState(entry, snapshot),
    changed,
  };
}

function sameReviewHook(a: StoredPluginHookReview, b: StoredPluginHookReview): boolean {
  return (
    a.rawEvent === b.rawEvent &&
    a.matcher === b.matcher &&
    a.commandDigest === b.commandDigest &&
    a.async === b.async &&
    a.timeoutMs === b.timeoutMs
  );
}

function diffHookReview(
  current: StoredPluginHookReview[],
  previous: StoredPluginHookReview[] | undefined,
): PluginHookReviewDiffItem[] {
  if (previous === undefined) return current.map((hook) => ({ change: "added", current: hook }));
  const unused = new Set(previous.map((_, index) => index));
  const items: PluginHookReviewDiffItem[] = [];

  for (const hook of current) {
    const exact = [...unused].find((index) => sameReviewHook(hook, previous[index]!));
    if (exact !== undefined) {
      unused.delete(exact);
      items.push({ change: "unchanged", current: hook, previous: previous[exact] });
      continue;
    }
    let changed = [...unused].find((index) => {
      const old = previous[index]!;
      return (
        old.rawEvent === hook.rawEvent &&
        (old.commandDigest === hook.commandDigest || old.matcher === hook.matcher)
      );
    });
    // If both command and matcher changed, pair the remaining command at the
    // same event when that match is unambiguous instead of presenting a noisy
    // remove+add pair.
    if (changed === undefined) {
      const sameEvent = [...unused].filter((index) => previous[index]!.rawEvent === hook.rawEvent);
      if (sameEvent.length === 1) changed = sameEvent[0];
    }
    if (changed !== undefined) {
      unused.delete(changed);
      items.push({ change: "changed", current: hook, previous: previous[changed] });
      continue;
    }
    items.push({ change: "added", current: hook });
  }
  for (const index of unused) items.push({ change: "removed", previous: previous[index] });
  return items;
}

function review(installKey: string, entry: PluginInstallEntry): PluginHookReview {
  const snapshot = inspectPluginHooks(entry.installPath);
  return {
    installKey,
    plugin: pluginNameFromKey(installKey),
    status: pluginHookApprovalState(entry, snapshot),
    baselineAvailable: entry.approvedHookSnapshot !== undefined,
    items: diffHookReview(pluginHookReviewSnapshot(snapshot), entry.approvedHookSnapshot),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

/** Review current hooks against the last explicitly approved per-command snapshot. */
export function reviewPluginHooks(target: string): PluginHookReview[] {
  const data = readInstalledPlugins();
  return matchingInstallKeys(data, target).flatMap((installKey) =>
    (data.plugins[installKey] ?? []).map((entry) => review(installKey, entry)),
  );
}

/** Approve the exact install-time digest; changed-on-disk hooks cannot be blessed. */
export function approvePluginHooks(target: string): PluginHookApprovalResult[] {
  const data = readInstalledPlugins();
  const keys = matchingInstallKeys(data, target);
  const out: PluginHookApprovalResult[] = [];
  let writeNeeded = false;

  for (const installKey of keys) {
    for (const entry of data.plugins[installKey] ?? []) {
      let entryChanged = false;
      const snapshot = inspectPluginHooks(entry.installPath);
      if (snapshot.state === "invalid") {
        throw new Error(
          `plugin "${installKey}" hooks definition is invalid and cannot be approved: ${snapshot.error ?? "unknown error"}`,
        );
      }
      if (entry.hookDigest && snapshot.digest !== entry.hookDigest) {
        throw new Error(
          `plugin "${installKey}" hooks changed after install; reinstall or update before approving`,
        );
      }
      if (!entry.hookDigest) {
        entry.hookDigest = snapshot.digest;
        entryChanged = true;
        writeNeeded = true;
      }
      if (entry.approvedHookDigest !== entry.hookDigest) {
        entry.approvedHookDigest = entry.hookDigest;
        entryChanged = true;
        writeNeeded = true;
      }
      const nextReview = pluginHookReviewSnapshot(snapshot);
      if (JSON.stringify(entry.approvedHookSnapshot) !== JSON.stringify(nextReview)) {
        entry.approvedHookSnapshot = nextReview;
        entryChanged = true;
        writeNeeded = true;
      }
      out.push(result(installKey, entry, entryChanged, snapshot));
    }
  }

  if (writeNeeded) writeInstalledPlugins(data);
  return out;
}

/**
 * Revoke hook execution. Legacy entries are first migrated to a recorded
 * digest so revocation fails closed instead of falling back to legacy trust.
 */
export function revokePluginHooks(target: string): PluginHookApprovalResult[] {
  const data = readInstalledPlugins();
  const keys = matchingInstallKeys(data, target);
  const out: PluginHookApprovalResult[] = [];
  let writeNeeded = false;

  for (const installKey of keys) {
    for (const entry of data.plugins[installKey] ?? []) {
      let entryChanged = false;
      const snapshot = inspectPluginHooks(entry.installPath);
      if (!entry.hookDigest) {
        entry.hookDigest = snapshot.digest;
        entryChanged = true;
      }
      if (snapshot.hasExecutableHooks || snapshot.state === "invalid") {
        if (entry.approvedHookDigest !== undefined) {
          delete entry.approvedHookDigest;
          entryChanged = true;
        }
      } else if (entry.approvedHookDigest !== entry.hookDigest) {
        entry.approvedHookDigest = entry.hookDigest;
        entryChanged = true;
      }
      writeNeeded ||= entryChanged;
      out.push(result(installKey, entry, entryChanged, snapshot));
    }
  }

  if (writeNeeded) writeInstalledPlugins(data);
  return out;
}
