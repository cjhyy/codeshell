/**
 * Trust state and approval for native plugins, plus the one action that
 * approves everything executable in a plugin at once (command hooks, MCP
 * servers and the native entry).
 */

import { isDeepStrictEqual } from "node:util";
import { mutateInstalledPlugins, readInstalledPlugins } from "../installedPlugins.js";
import { readPluginMcp } from "../installer/loadPluginMcp.js";
import {
  approveHookEntry,
  matchingInstallKeys,
  pluginNameFromKey,
  revokeHookEntry,
} from "../pluginHookApproval.js";
import {
  inspectPluginHooks,
  pluginHookApprovalState,
  type PluginHookApprovalState,
} from "../pluginHookIntegrity.js";
import { approveMcpEntry, revokeMcpEntry } from "../pluginMcpApproval.js";
import { pluginMcpApprovalState, type PluginMcpApprovalState } from "../pluginMcpIntegrity.js";
import { approvePluginContent, pluginContentState } from "../pluginTreeDigest.js";
import type { PluginInstallEntry } from "../types.js";
import {
  diffNativeSurface,
  NATIVE_PLUGIN_API_VERSION,
  nativeNamingProblem,
  nativePluginSurface,
  readNativePluginManifest,
  type NativePluginManifest,
  type NativePluginSurface,
  type NativeSurfaceDiff,
} from "./manifest.js";

/**
 * - `none`: the plugin has no native entry.
 * - `invalid`: it has one, but the manifest or its names cannot be used.
 * - `incompatible`: it was written against a newer `ctx` than this host has.
 * - `pending` / `changed` / `approved`: as for hooks and MCP servers. Only
 *   `approved` may start a process.
 */
export type NativePluginState =
  | "none"
  | "invalid"
  | "incompatible"
  | "pending"
  | "changed"
  | "approved";

export interface NativePluginInspection {
  state: NativePluginState;
  manifest?: NativePluginManifest;
  surface?: NativePluginSurface;
  error?: string;
}

/**
 * Read one install's native manifest and decide whether it may run. Approval
 * binds to the whole install tree, like hooks and MCP servers, and has its own
 * record so that approving another executable kind never starts this one.
 */
export function inspectNativePlugin(
  installKey: string,
  entry: PluginInstallEntry,
): NativePluginInspection {
  const read = readNativePluginManifest(entry.installPath);
  if (read.kind === "none") return { state: "none" };
  if (read.kind === "invalid") return { state: "invalid", error: read.error };
  const manifest = read.manifest;
  const surface = nativePluginSurface(manifest);
  const naming = nativeNamingProblem(pluginNameFromKey(installKey), manifest);
  if (naming) return { state: "invalid", manifest, surface, error: naming };
  if (manifest.apiVersion > NATIVE_PLUGIN_API_VERSION) {
    return {
      state: "incompatible",
      manifest,
      surface,
      error: `needs plugin API ${manifest.apiVersion}; this CodeShell provides ${NATIVE_PLUGIN_API_VERSION}`,
    };
  }
  const content = pluginContentState(entry);
  if (content === "changed") return { state: "changed", manifest, surface };
  return {
    state:
      content === "approved" && entry.approvedNativeDigest === entry.contentDigest
        ? "approved"
        : "pending",
    manifest,
    surface,
  };
}

/**
 * Fields written at install/update. The native approval survives only for a
 * byte-identical tree; the approved surface is kept across updates because it
 * is what the next review is compared against.
 */
export function pluginNativeInstallRecord(
  contentDigest: string | undefined,
  previousEntries: PluginInstallEntry[] = [],
): Pick<PluginInstallEntry, "approvedNativeDigest" | "approvedNativeSurface"> {
  const approved =
    contentDigest !== undefined &&
    previousEntries.some(
      (entry) =>
        entry.contentDigest === contentDigest && entry.approvedNativeDigest === contentDigest,
    );
  const baseline = previousEntries.find(
    (entry) => entry.approvedNativeSurface !== undefined,
  )?.approvedNativeSurface;
  return {
    ...(approved ? { approvedNativeDigest: contentDigest } : {}),
    ...(baseline ? { approvedNativeSurface: baseline } : {}),
  };
}

function approveNativeEntry(
  installKey: string,
  entry: PluginInstallEntry,
  inspection: NativePluginInspection,
): boolean {
  if (inspection.state === "invalid" || inspection.state === "incompatible") {
    throw new Error(
      `plugin "${installKey}" native entry cannot be approved: ${inspection.error ?? inspection.state}`,
    );
  }
  let changed = approvePluginContent(installKey, entry);
  if (entry.approvedNativeDigest !== entry.contentDigest) {
    entry.approvedNativeDigest = entry.contentDigest;
    changed = true;
  }
  if (!isDeepStrictEqual(entry.approvedNativeSurface, inspection.surface)) {
    entry.approvedNativeSurface = inspection.surface;
    changed = true;
  }
  return changed;
}

export interface PluginApprovalSummary {
  installKey: string;
  plugin: string;
  hooks: PluginHookApprovalState;
  mcp: PluginMcpApprovalState;
  native: NativePluginState;
  changed: boolean;
}

function summarize(
  installKey: string,
  entry: PluginInstallEntry,
  changed: boolean,
): PluginApprovalSummary {
  const plugin = pluginNameFromKey(installKey);
  return {
    installKey,
    plugin,
    hooks: pluginHookApprovalState(entry),
    mcp: pluginMcpApprovalState(
      entry,
      Object.keys(readPluginMcp(entry.installPath, plugin)).length > 0,
    ),
    native: inspectNativePlugin(installKey, entry).state,
    changed,
  };
}

/**
 * Approve everything executable in a plugin with one decision: its command
 * hooks, its MCP servers and its native entry. Each kind is approved only if
 * the plugin actually has it. One registry write covers all of them, so a kind
 * that cannot be approved (changed bytes, an unusable manifest) fails the
 * whole action and leaves the record untouched.
 */
export function approvePlugin(target: string, beforeCommit?: () => void): PluginApprovalSummary[] {
  return (
    mutateInstalledPlugins((data) => {
      const out: PluginApprovalSummary[] = [];
      let writeNeeded = false;
      for (const installKey of matchingInstallKeys(data, target, "plugin approval")) {
        const plugin = pluginNameFromKey(installKey);
        for (const entry of data.plugins[installKey] ?? []) {
          let changed = false;
          const hooks = inspectPluginHooks(entry.installPath);
          if (hooks.hasExecutableHooks) changed = approveHookEntry(installKey, entry, hooks);
          if (Object.keys(readPluginMcp(entry.installPath, plugin)).length > 0) {
            changed = approveMcpEntry(installKey, plugin, entry) || changed;
          }
          const native = inspectNativePlugin(installKey, entry);
          if (native.state !== "none") {
            changed = approveNativeEntry(installKey, entry, native) || changed;
          }
          writeNeeded ||= changed;
          out.push(summarize(installKey, entry, changed));
        }
      }
      if (writeNeeded) beforeCommit?.();
      return { ...(writeNeeded ? { value: data } : {}), result: out };
    }) ?? []
  );
}

/**
 * Revoke everything executable in a plugin. The approved surface is kept: it
 * is display metadata and the baseline for the next review.
 */
export function revokePlugin(target: string, beforeCommit?: () => void): PluginApprovalSummary[] {
  return (
    mutateInstalledPlugins((data) => {
      const out: PluginApprovalSummary[] = [];
      let writeNeeded = false;
      for (const installKey of matchingInstallKeys(data, target, "plugin approval")) {
        const plugin = pluginNameFromKey(installKey);
        for (const entry of data.plugins[installKey] ?? []) {
          let changed = revokeHookEntry(entry);
          changed = revokeMcpEntry(plugin, entry) || changed;
          if (entry.approvedNativeDigest !== undefined) {
            delete entry.approvedNativeDigest;
            changed = true;
          }
          writeNeeded ||= changed;
          out.push(summarize(installKey, entry, changed));
        }
      }
      if (writeNeeded) beforeCommit?.();
      return { ...(writeNeeded ? { value: data } : {}), result: out };
    }) ?? []
  );
}

// A review is made of these; hosts that show one need their types.
export type { NativePluginSurface, NativeSurfaceDiff } from "./manifest.js";

export interface NativePluginReview {
  installKey: string;
  plugin: string;
  state: NativePluginState;
  /** Absent only when the manifest could not be read at all. */
  surface?: NativePluginSurface;
  /** Whether an earlier approval exists to compare against. */
  baselineAvailable: boolean;
  /** What the current manifest adds or drops relative to the last approval. */
  diff?: NativeSurfaceDiff;
  error?: string;
}

function review(installKey: string, entry: PluginInstallEntry): NativePluginReview {
  const inspection = inspectNativePlugin(installKey, entry);
  return {
    installKey,
    plugin: pluginNameFromKey(installKey),
    state: inspection.state,
    baselineAvailable: entry.approvedNativeSurface !== undefined,
    ...(inspection.surface
      ? {
          surface: inspection.surface,
          diff: diffNativeSurface(entry.approvedNativeSurface, inspection.surface),
        }
      : {}),
    ...(inspection.error ? { error: inspection.error } : {}),
  };
}

/** Every install that has a native entry, in registry (install) order. */
export function listNativePlugins(): NativePluginReview[] {
  const data = readInstalledPlugins();
  return Object.entries(data.plugins).flatMap(([installKey, entries]) =>
    entries.map((entry) => review(installKey, entry)).filter((item) => item.state !== "none"),
  );
}

/** Review the native entry of the installs the target names. */
export function reviewNativePlugin(target: string): NativePluginReview[] {
  const data = readInstalledPlugins();
  return matchingInstallKeys(data, target, "plugin review").flatMap((installKey) =>
    (data.plugins[installKey] ?? []).map((entry) => review(installKey, entry)),
  );
}
