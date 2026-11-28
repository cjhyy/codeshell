import { lstatSync } from "node:fs";

/**
 * Coarse-clock filesystems (FAT, HFS+, some network mounts) can record two
 * writes in one timestamp tick. A file changed this recently cannot prove its
 * content from metadata alone, so it is always re-read.
 */
const RACY_WINDOW_MS = 2_000;

/** One cache input: a file's content identity, or only a directory's identity. */
export type StampInput = string | { readonly directory: string };

/**
 * Metadata identity of one path without following a final symlink, matching
 * the no-follow reads of settings and credential stores. A missing path is a
 * valid input ("-"); undefined means the stamp cannot be trusted as a key.
 */
export function fileStamp(path: string, nowMs = Date.now()): string | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    // A content write moves mtime; ctime is still part of the stamp so a write
    // followed by restoring the old mtime is a different stamp too.
    if (nowMs - Number(info.mtimeMs) < RACY_WINDOW_MS) return undefined;
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "-" : undefined;
  }
}

/**
 * A directory's identity changes when it is replaced or swapped for a link,
 * but not when unrelated siblings are written (its mtime is deliberately
 * excluded so busy state directories do not defeat the cache).
 */
function directoryStamp(path: string): string | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "-" : undefined;
  }
}

function inputsStamp(inputs: readonly StampInput[]): string | undefined {
  const nowMs = Date.now();
  const parts: string[] = [];
  for (const input of inputs) {
    const path = typeof input === "string" ? input : input.directory;
    const stamp = typeof input === "string" ? fileStamp(path, nowMs) : directoryStamp(path);
    if (stamp === undefined) return undefined;
    parts.push(`${path}\0${stamp}`);
  }
  return parts.join("\0\0");
}

/**
 * Memoizes a pure function of on-disk files. An entry is reused only while
 * every listed input still has the stamp observed BEFORE the value was
 * computed, so a write racing the computation can only cause a miss, never
 * a stale hit. Callers must list every file the computation reads.
 */
export class StampedMemo<V> {
  private readonly entries = new Map<string, { stamp: string; value: V }>();

  constructor(private readonly maxEntries = 32) {}

  get(key: string, inputs: readonly StampInput[], compute: () => V): V {
    const stamp = inputsStamp(inputs);
    if (stamp === undefined) {
      this.entries.delete(key);
      return compute();
    }
    const hit = this.entries.get(key);
    if (hit?.stamp === stamp) return hit.value;
    const value = compute();
    this.entries.delete(key);
    this.entries.set(key, { stamp, value });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
