/**
 * Runtime snapshots of native plugins.
 *
 * A native entry is never loaded from its install directory. The approved
 * tree is copied to a private location, the copy's digest is compared with
 * the digest the user approved, and only then is the copy made read-only and
 * handed to the plugin process. What runs is therefore the bytes that were
 * checked, even if the install directory changes a moment later, and a plugin
 * that tries to keep state next to its code fails at once instead of quietly
 * turning itself into changed content.
 *
 * Layout: `<home>/.code-shell/plugin-runtime/<module id>/<first 16 of digest>/`.
 * It sits beside the plugin install root, not inside it, so nothing mistakes a
 * snapshot for an installed plugin.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pluginsRoot } from "../installer/paths.js";
import { computePluginTreeDigest } from "../pluginTreeDigest.js";
import { nativeModuleId } from "./manifest.js";

const STALE_TEMPORARY_MS = 60 * 60 * 1000;
export const NATIVE_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function nativeRuntimeRoot(): string {
  return join(dirname(pluginsRoot()), "plugin-runtime");
}

export function nativeSnapshotDir(moduleId: string, contentDigest: string): string {
  return join(nativeRuntimeRoot(), moduleId, contentDigest.slice(0, 16));
}

export type NativeSnapshot = { ok: true; root: string } | { ok: false; reason: string };

/** Walk a tree we own and flip the write bits; symlinks are left alone. */
function setWritable(root: string, writable: boolean): void {
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      // A directory must be writable while its entries are visited and removed.
      if (writable) chmodSync(path, info.mode | 0o700);
      for (const name of readdirSync(path)) visit(join(path, name));
      if (!writable) chmodSync(path, info.mode & ~0o222);
    } else {
      chmodSync(path, writable ? info.mode | 0o600 : info.mode & ~0o222);
    }
  };
  visit(root);
}

/** Remove a snapshot directory, which is read-only by construction. */
export function removeNativeSnapshot(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    setWritable(dir, true);
  } catch {
    // Fall through: rm reports what could not be removed.
  }
  rmSync(dir, { recursive: true, force: true });
}

function matches(dir: string, contentDigest: string): boolean {
  const tree = computePluginTreeDigest(dir);
  return tree.ok && tree.digest === contentDigest;
}

/**
 * Make sure a verified, read-only copy of the approved tree exists and return
 * it. An existing snapshot is re-verified rather than trusted: it is a file on
 * disk like any other.
 */
export function prepareNativeSnapshot(input: {
  moduleId: string;
  installPath: string;
  contentDigest: string;
}): NativeSnapshot {
  const target = nativeSnapshotDir(input.moduleId, input.contentDigest);
  try {
    if (existsSync(target)) {
      if (matches(target, input.contentDigest)) return { ok: true, root: target };
      removeNativeSnapshot(target);
    }
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `.tmp-${process.pid}-${randomUUID()}`);
    try {
      cpSync(input.installPath, temporary, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      // The digest does not cover the clone's own bookkeeping; do not carry it.
      rmSync(join(temporary, ".git"), { recursive: true, force: true });
      if (!matches(temporary, input.contentDigest)) {
        return {
          ok: false,
          reason: "the install directory no longer matches the approved content",
        };
      }
      setWritable(temporary, false);
      // macOS refuses to rename a directory that is itself read-only, so the
      // root keeps its write bit until it is in place.
      chmodSync(temporary, 0o700);
      try {
        renameSync(temporary, target);
        chmodSync(target, 0o500);
      } catch (error) {
        // Another process finished the same snapshot first; use theirs if it verifies.
        if (!existsSync(target) || !matches(target, input.contentDigest)) throw error;
      }
      return { ok: true, root: target };
    } finally {
      if (existsSync(temporary)) removeNativeSnapshot(temporary);
    }
  } catch (error) {
    return {
      ok: false,
      reason: `could not prepare the runtime snapshot: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Drop every snapshot of one plugin module (uninstall). */
export function removeNativeSnapshots(moduleId: string): void {
  const dir = join(nativeRuntimeRoot(), moduleId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) removeNativeSnapshot(join(dir, name));
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Uninstall: drop the plugin's runtime copies and its process log. Never
 * fails an uninstall; a copy left behind is collected on a later start.
 */
export function removeNativeRuntimeFiles(plugin: string, installKey: string): void {
  try {
    const moduleId = nativeModuleId(plugin, installKey);
    removeNativeSnapshots(moduleId);
    for (const file of [`${moduleId}.log`, `${moduleId}.log.1`]) {
      rmSync(join(nativeRuntimeRoot(), ".logs", file), { force: true });
    }
  } catch {
    /* best effort */
  }
}

/**
 * Remove snapshots nothing refers to any more. A snapshot that is not in
 * `keep` is only removed once it is older than the retention period, so a
 * plugin that is being re-approved does not lose the copy a running process
 * may still be using. Leftover temporary directories go after an hour.
 */
export function collectNativeSnapshots(
  keep: ReadonlySet<string>,
  options: { now?: number; retentionMs?: number } = {},
): string[] {
  const root = nativeRuntimeRoot();
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? NATIVE_SNAPSHOT_RETENTION_MS;
  const removed: string[] = [];
  let modules: string[];
  try {
    modules = readdirSync(root);
  } catch {
    return removed;
  }
  for (const moduleId of modules) {
    if (!moduleId.startsWith("plugin-")) continue;
    const moduleDir = join(root, moduleId);
    let names: string[];
    try {
      names = readdirSync(moduleDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(moduleDir, name);
      if (keep.has(dir)) continue;
      let age: number;
      try {
        age = now - statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (age < (name.startsWith(".tmp-") ? STALE_TEMPORARY_MS : retentionMs)) continue;
      try {
        removeNativeSnapshot(dir);
        removed.push(dir);
      } catch {
        // Best effort: it is tried again on the next start.
      }
    }
    try {
      if (readdirSync(moduleDir).length === 0) rmSync(moduleDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return removed;
}
