import { lstatSync, readFileSync } from "node:fs";

interface PinnedEntry<T> {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  value: T;
}

/**
 * Parsed copies of small files that other writers may replace at any time,
 * each pinned to the file's identity (device, inode, size, mtime, ctime). Any rewrite
 * changes the pin: a rename gives a new inode, and ctime moves on every write
 * and cannot be restored with utimes, which covers in-place restores that keep
 * inode, size and mtime. A file changed within `settleMs` is never cached,
 * since a second write in the same timestamp tick would leave its pin intact.
 */
export class PinnedFileCache<T> {
  private readonly entries = new Map<string, PinnedEntry<T>>();
  private bytes = 0;

  constructor(
    private readonly options: {
      maxBytes: number;
      settleMs: number;
      now: () => number;
      parse: (raw: string, key: string) => T | undefined;
      readText?: (file: string) => string;
      maxEntries?: number;
      maxCachedBytes?: number;
    },
  ) {
    for (const limit of [options.maxEntries, options.maxCachedBytes]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
        throw new Error("Invalid receipt cache budget");
    }
  }

  /** The parsed file, or undefined when it is missing, oversized, a link or invalid. */
  read(key: string, file: string): T | undefined {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.options.maxBytes) {
        this.forget(key);
        return undefined;
      }
      const cached = this.entries.get(key);
      if (
        cached &&
        cached.dev === stat.dev &&
        cached.ino === stat.ino &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs
      ) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.value;
      }
      this.forget(key);
      // Read after stat: a concurrent replacement leaves a stale pin on newer
      // content, which only costs one extra read on the next lookup.
      const raw = (this.options.readText ?? ((path) => readFileSync(path, "utf8")))(file);
      const value = this.options.parse(raw, key);
      if (value === undefined) return undefined;
      if (this.options.now() - Math.max(stat.mtimeMs, stat.ctimeMs) > this.options.settleMs) {
        this.entries.set(key, {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          value,
        });
        this.bytes += stat.size;
        while (
          this.entries.size > (this.options.maxEntries ?? 10_000) ||
          this.bytes > (this.options.maxCachedBytes ?? 8 * 1024 * 1024)
        ) {
          this.forget(this.entries.keys().next().value!);
        }
      }
      return value;
    } catch {
      this.forget(key);
      return undefined;
    }
  }

  /** Drop entries for files no longer present, keeping the cache bounded by the store. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.forget(key);
  }

  private forget(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.size;
    this.entries.delete(key);
  }
}
