/**
 * Mtime-keyed LRU cache over the disclosure latest-result reader. One entry
 * per session; bounded so a long-lived main process cannot grow unboundedly.
 * Failed reads are never cached, so a transient error can be retried on the
 * next expand even when the transcript mtime has not changed.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  LATEST_RESULT_MAX_CHARS,
  readLatestAssistantText,
  type LatestAssistantText,
} from "@cjhyy/code-shell-pet/disclosure";

const DEFAULT_MAX_ENTRIES = 200;

export function createLatestResultCache(
  sessionsRootDir: string,
  options?: {
    maxEntries?: number;
    /** Injectable reader (defaults to the disclosure reader); test seam. */
    read?: (
      sessionDir: string,
      options: { maxChars: number },
    ) => Promise<LatestAssistantText | null>;
  },
): {
  read(sessionId: string): Promise<LatestAssistantText | null>;
} {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const readLatest = options?.read ?? readLatestAssistantText;
  const cache = new Map<string, { mtimeMs: number; value: LatestAssistantText | null }>();
  return {
    async read(sessionId) {
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
      let value: LatestAssistantText | null;
      try {
        value = await readLatest(dir, { maxChars: LATEST_RESULT_MAX_CHARS });
      } catch {
        // Do NOT cache the failure: with an unchanged mtime a cached null
        // would pin this session to "no result" forever.
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
