/**
 * File state cache — avoids re-reading unchanged files within a session.
 * Keyed by absolute path, invalidated on mtime change or manual write.
 */
import { stat } from "node:fs/promises";

interface CacheEntry {
  content: string;
  mtimeMs: number;
}

class FileStateCache {
  private cache = new Map<string, CacheEntry>();

  async get(filePath: string): Promise<string | null> {
    const entry = this.cache.get(filePath);
    if (!entry) return null;
    try {
      const s = await stat(filePath);
      if (s.mtimeMs === entry.mtimeMs) return entry.content;
      // File changed on disk — invalidate
      this.cache.delete(filePath);
      return null;
    } catch {
      this.cache.delete(filePath);
      return null;
    }
  }

  set(filePath: string, content: string, mtimeMs: number): void {
    this.cache.set(filePath, { content, mtimeMs });
  }

  /** Invalidate a specific path (after Write/Edit). */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * True if a cache entry for `filePath` is currently held. Pure key-presence
   * check — does NOT stat/self-heal like `get()`, so a test can assert a manual
   * `invalidate()` actually removed the key without the mtime path masking it.
   */
  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  get size(): number {
    return this.cache.size;
  }
}

export const fileCache = new FileStateCache();
