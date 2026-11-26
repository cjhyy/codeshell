/**
 * Whole-tree digest for one installed plugin.
 *
 * Approval of executable plugin content (command hooks, MCP servers) binds to
 * every byte under the install path, not only to the declaration file. The
 * declaration says WHICH command runs; the scripts that command launches live
 * elsewhere in the tree, so a digest of hooks/hooks.json alone lets them change
 * without invalidating the approval.
 *
 * The digest is persisted in installed_plugins.json and re-verified by every
 * runtime that loads the plugin (Electron's Node, Bun, plain Node). Everything
 * that feeds it must therefore be identical across runtimes: entries are
 * ordered by UTF-16 code unit, never by `localeCompare` (Bun and Node disagree
 * on that order), and paths are written with `/` separators.
 */

import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import type { PluginInstallEntry } from "./types.js";

const DIGEST_DOMAIN = "codeshell-plugin-tree-v1";

/** The same bounds a plugin source must already satisfy to be installed. */
export const MAX_PLUGIN_TREE_ENTRIES = 10_000;
export const MAX_PLUGIN_TREE_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_TREE_DEPTH = 32;

/**
 * Root entries the plugin author does not ship. `.cs-meta.json` and
 * `.code-shell-installed.json` are written by the installer (and rewritten
 * after the install record exists) with timestamps, so covering them would
 * turn every reinstall of identical bytes into new content. `.git` is the
 * marketplace clone's own bookkeeping, which git rewrites on its own.
 *
 * Only the ROOT entries are skipped. The same names deeper in the tree are
 * plugin content. Apart from the one OS metadata file below, nothing else is
 * skipped: a skipped path is an executable path that approval does not
 * protect, which is why `node_modules` and `__pycache__` stay covered.
 */
const SKIPPED_ROOT_ENTRIES = new Set([".git", ".cs-meta.json", ".code-shell-installed.json"]);

/**
 * Finder writes this into any directory the user merely opens. It is skipped
 * at every depth: otherwise looking at an installed plugin in Finder would
 * turn it into changed content that only a reinstall can clear.
 */
const SKIPPED_OS_METADATA = ".DS_Store";

/**
 * A file changed within this window of the observation may change again
 * without its timestamp moving on a coarse-grained filesystem, so a tree that
 * was touched this recently is hashed every time instead of being cached.
 */
const RACY_WINDOW_MS = 2_000;
const MAX_CACHED_TREES = 256;
const READ_CHUNK_BYTES = 256 * 1024;

export type PluginTreeDigest = { ok: true; digest: string } | { ok: false; reason: string };

export interface PluginTreeLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxDepth?: number;
}

type EntryKind = "dir" | "file" | "link" | "other";

interface TreeEntry {
  rel: string;
  path: string;
  kind: EntryKind;
  stats: BigIntStats;
}

interface TreeListing {
  entries: TreeEntry[];
  /** Identity of every entry's metadata; equal fingerprints mean no entry was touched. */
  fingerprint: string;
  newestMs: number;
}

class PluginTreeError extends Error {}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function kindOf(stats: BigIntStats): EntryKind {
  if (stats.isDirectory()) return "dir";
  if (stats.isSymbolicLink()) return "link";
  if (stats.isFile()) return "file";
  return "other";
}

function describeTreeError(error: unknown): string {
  if (error instanceof PluginTreeError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "plugin install path is missing";
  return `plugin tree is unreadable${code ? ` (${code})` : ""}`;
}

function listTree(root: string, limits: Required<PluginTreeLimits>): TreeListing {
  if (!lstatSync(root, { bigint: true }).isDirectory()) {
    throw new PluginTreeError("plugin install path is not a directory");
  }
  const entries: TreeEntry[] = [];
  const fingerprint = createHash("sha256");
  const maxBytes = BigInt(limits.maxBytes);
  let bytes = 0n;
  let newestNs = 0n;

  const walk = (directory: string, prefix: string, depth: number): void => {
    for (const name of readdirSync(directory).sort(compareCodeUnits)) {
      if (name === SKIPPED_OS_METADATA) continue;
      if (depth === 0 && SKIPPED_ROOT_ENTRIES.has(name)) continue;
      const path = join(directory, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(path, { bigint: true });
      const kind = kindOf(stats);
      if (entries.length >= limits.maxEntries) {
        throw new PluginTreeError(`plugin tree contains more than ${limits.maxEntries} entries`);
      }
      if (kind === "file") {
        bytes += stats.size;
        if (bytes > maxBytes) {
          throw new PluginTreeError(`plugin tree exceeds ${limits.maxBytes} bytes`);
        }
      }
      entries.push({ rel, path, kind, stats });
      // File names cannot contain NUL, so NUL-delimited fields are unambiguous.
      fingerprint.update(
        `${kind}\0${rel}\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.ino}\0${stats.dev}\n`,
      );
      if (stats.mtimeNs > newestNs) newestNs = stats.mtimeNs;
      if (stats.ctimeNs > newestNs) newestNs = stats.ctimeNs;
      if (kind === "dir") {
        if (depth + 1 > limits.maxDepth) {
          throw new PluginTreeError(
            `plugin tree exceeds the maximum directory depth ${limits.maxDepth}`,
          );
        }
        walk(path, rel, depth + 1);
      }
    }
  };
  walk(root, "", 0);
  return {
    entries,
    fingerprint: fingerprint.digest("hex"),
    newestMs: Number(newestNs / 1_000_000n),
  };
}

function hashFile(hash: Hash, entry: TreeEntry, chunk: Buffer): void {
  // O_NONBLOCK keeps a FIFO swapped in after the listing from blocking the open.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(entry.path, flags);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== entry.stats.ino || opened.dev !== entry.stats.dev) {
      throw new PluginTreeError("plugin tree changed while it was being hashed");
    }
    hash.update(`${opened.size}\0`);
    let total = 0n;
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      if (total > opened.size) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (total !== opened.size) {
      throw new PluginTreeError("plugin tree changed while it was being hashed");
    }
    hash.update("\0");
  } finally {
    closeSync(fd);
  }
}

/**
 * Every field is length-prefixed, so no file content or name can be mistaken
 * for the framing of a neighbouring entry. A symlink contributes its target
 * string; what it points to is never read.
 */
function hashEntries(entries: TreeEntry[]): string {
  const hash = createHash("sha256").update(DIGEST_DOMAIN).update("\0");
  // One read buffer for the whole tree: a fresh one per file costs more than the read.
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${Buffer.byteLength(entry.rel)}\0${entry.rel}\0`);
    if (entry.kind === "link") {
      const target = readlinkSync(entry.path);
      hash.update(`${Buffer.byteLength(target)}\0${target}\0`);
    } else if (entry.kind === "file") {
      hashFile(hash, entry, chunk);
    }
  }
  return hash.digest("hex");
}

function resolveLimits(limits: PluginTreeLimits): Required<PluginTreeLimits> {
  return {
    maxEntries: limits.maxEntries ?? MAX_PLUGIN_TREE_ENTRIES,
    maxBytes: limits.maxBytes ?? MAX_PLUGIN_TREE_BYTES,
    maxDepth: limits.maxDepth ?? MAX_PLUGIN_TREE_DEPTH,
  };
}

/** Hash the tree now, without consulting or filling the cache. */
export function computePluginTreeDigest(
  root: string,
  limits: PluginTreeLimits = {},
): PluginTreeDigest {
  try {
    return { ok: true, digest: hashEntries(listTree(root, resolveLimits(limits)).entries) };
  } catch (error) {
    return { ok: false, reason: describeTreeError(error) };
  }
}

interface CachedTree {
  fingerprint: string;
  digest: string;
}

const cache = new Map<string, CachedTree>();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * The tree's current digest. Loaders call this for every engine they build,
 * so an unchanged tree costs one metadata walk: the bytes are re-read only
 * when some entry's size, timestamps or inode moved since the cached hash.
 * The cache lives in this process only.
 */
export function pluginTreeDigest(
  root: string,
  options: { now?: () => number } = {},
): PluginTreeDigest {
  const limits = resolveLimits({});
  let listing: TreeListing;
  try {
    listing = listTree(root, limits);
  } catch (error) {
    cache.delete(root);
    return { ok: false, reason: describeTreeError(error) };
  }
  const cached = cache.get(root);
  if (cached?.fingerprint === listing.fingerprint) {
    cacheHits += 1;
    return { ok: true, digest: cached.digest };
  }
  cacheMisses += 1;
  cache.delete(root);

  let digest: string;
  try {
    digest = hashEntries(listing.entries);
  } catch (error) {
    return { ok: false, reason: describeTreeError(error) };
  }
  if ((options.now ?? Date.now)() - listing.newestMs > RACY_WINDOW_MS) {
    try {
      // Cache only what provably did not move while it was being read.
      if (listTree(root, limits).fingerprint === listing.fingerprint) {
        if (cache.size >= MAX_CACHED_TREES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(root, { fingerprint: listing.fingerprint, digest });
      }
    } catch {
      // The hash of what was read is still the answer; it is just not reusable.
    }
  }
  return { ok: true, digest };
}

/** @internal Test hook. */
export function _resetPluginTreeDigestCache(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/** @internal Test hook. */
export function _pluginTreeDigestCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/**
 * - `unrecorded`: the install predates whole-tree approval.
 * - `changed`: the bytes on disk are not the bytes recorded at install/update,
 *   or cannot be digested at all.
 * - `unapproved` / `approved`: the recorded bytes are intact; the user has not
 *   / has agreed to run them.
 */
export type PluginContentState = "unrecorded" | "changed" | "unapproved" | "approved";

export function pluginContentState(entry: PluginInstallEntry): PluginContentState {
  if (!entry.contentDigest) return "unrecorded";
  const tree = pluginTreeDigest(entry.installPath);
  if (!tree.ok || tree.digest !== entry.contentDigest) return "changed";
  return entry.approvedContentDigest === entry.contentDigest ? "approved" : "unapproved";
}

/**
 * Record the user's agreement to run executable content from the tree that is
 * on disk now. Bytes that changed since install cannot be blessed in place.
 * Returns whether the entry changed.
 */
export function approvePluginContent(installKey: string, entry: PluginInstallEntry): boolean {
  const tree = pluginTreeDigest(entry.installPath);
  if (!tree.ok) {
    throw new Error(`plugin "${installKey}" content cannot be approved: ${tree.reason}`);
  }
  if (entry.contentDigest && tree.digest !== entry.contentDigest) {
    throw new Error(
      `plugin "${installKey}" content changed after install; reinstall or update before approving`,
    );
  }
  let changed = false;
  if (!entry.contentDigest) {
    entry.contentDigest = tree.digest;
    changed = true;
  }
  if (entry.approvedContentDigest !== entry.contentDigest) {
    entry.approvedContentDigest = entry.contentDigest;
    changed = true;
  }
  return changed;
}

/**
 * Fields written at install/update. Content is never approved implicitly: the
 * approval survives an update only when the new tree is byte-identical to one
 * the user already approved. A tree that cannot be digested gets no record,
 * which keeps its executable content pending and unapprovable.
 */
export function pluginContentInstallRecord(
  installPath: string,
  previousEntries: PluginInstallEntry[] = [],
): Pick<PluginInstallEntry, "contentDigest" | "approvedContentDigest"> {
  const tree = pluginTreeDigest(installPath);
  if (!tree.ok) return {};
  const previouslyApproved = previousEntries.some(
    (entry) =>
      entry.contentDigest === tree.digest && entry.approvedContentDigest === entry.contentDigest,
  );
  return {
    contentDigest: tree.digest,
    ...(previouslyApproved ? { approvedContentDigest: tree.digest } : {}),
  };
}
