/**
 * Shared mtime-keyed LRU cache over a per-session on-disk reader. One entry per
 * session, bounded so a long-lived main process cannot grow unboundedly. Keyed
 * by the session's transcript mtime: an unchanged mtime serves the cached value
 * (refreshing its LRU position), a changed mtime re-reads. Failed reads are
 * never cached, so a transient error can be retried on the next get even when
 * the transcript mtime has not changed.
 *
 * Only the cache skeleton lives here — each caller keeps its own reader,
 * arguments, and result shape (see latest-result-cache.ts, pet-todo-aggregator.ts).
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAX_ENTRIES = 200;

export function createMtimeSessionCache<T>(
  sessionsRootDir: string,
  read: (sessionDir: string) => Promise<T>,
  options?: { maxEntries?: number },
): { get(sessionId: string): Promise<T | null> } {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, { mtimeMs: number; value: T }>();
  return {
    async get(sessionId) {
      const dir = join(sessionsRootDir, sessionId);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(join(dir, "transcript.jsonl"))).mtimeMs;
      } catch {
        return null;
      }
      const cached = cache.get(sessionId);
      if (cached && cached.mtimeMs === mtimeMs) {
        // Refresh the entry's LRU position on a hit.
        cache.delete(sessionId);
        cache.set(sessionId, cached);
        return cached.value;
      }
      let value: T;
      try {
        value = await read(dir);
      } catch {
        // Do NOT cache the failure: with an unchanged mtime a cached value
        // would pin this session forever.
        return null;
      }
      cache.delete(sessionId);
      cache.set(sessionId, { mtimeMs, value });
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    },
  };
}
