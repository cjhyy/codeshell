/**
 * Cleanup of the browser partitions external-runtime sessions used to own.
 *
 * An external Claude Code / Codex session was once bound to its own bucket
 * `external-runtime:<sessionId>`, which Electron stored as the partition
 * `persist:browser:p:external-runtime:<sessionId>`. Those sessions now use the
 * project's bucket, so nothing opens the old partitions again: each one is a
 * cookie jar and cache that only takes disk space.
 *
 * Electron names a persistent partition's directory after the partition with
 * `persist:` removed and the rest percent-encoded
 * (`browser%3Ap%3Aexternal-runtime%3A<sessionId>`). Only a real directory whose
 * decoded name is exactly that shape is removed; everything else under
 * `Partitions` is left alone.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Decoded directory name of a retired per-session partition. */
const ORPHANED_PARTITION_NAME = /^browser:p:external-runtime:[a-zA-Z0-9_.@-]+$/u;

/** Whether a `Partitions` entry name is a retired external-runtime partition. */
export function isOrphanedExternalRuntimePartitionDir(name: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return false;
  }
  // Only the encoding Electron itself writes: no second spelling of a name.
  return ORPHANED_PARTITION_NAME.test(decoded) && encodeURIComponent(decoded) === name;
}

export interface OrphanedPartitionCleanupResult {
  removed: number;
  /** A live webContents still stores into it; left for a later launch. */
  inUse: number;
  failed: number;
}

/**
 * Remove the retired partition directories under `partitionsDir`.
 *
 * `inUse(directory)` is asked right before each removal. Symbolic links are
 * never followed: a link named like a partition is skipped, and links inside a
 * removed directory are unlinked, not traversed. Never throws.
 */
export async function removeOrphanedExternalRuntimePartitions(options: {
  partitionsDir: string;
  inUse: (directory: string) => boolean;
}): Promise<OrphanedPartitionCleanupResult> {
  const result: OrphanedPartitionCleanupResult = { removed: 0, inUse: 0, failed: 0 };
  let names: string[];
  try {
    names = await readdir(options.partitionsDir);
  } catch {
    // No Partitions directory yet (first launch), or it cannot be read.
    return result;
  }
  for (const name of names) {
    if (!isOrphanedExternalRuntimePartitionDir(name)) continue;
    const directory = join(options.partitionsDir, name);
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      if (options.inUse(directory)) {
        result.inUse++;
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
