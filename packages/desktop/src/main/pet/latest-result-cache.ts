/**
 * Mtime-keyed LRU cache over the disclosure latest-result reader. One entry
 * per session; bounded so a long-lived main process cannot grow unboundedly.
 * Failed reads are never cached, so a transient error can be retried on the
 * next expand even when the transcript mtime has not changed.
 *
 * The cache skeleton lives in mtime-session-cache.ts; this module keeps the
 * latest-result reader, its maxChars argument, and the public signature.
 */
import {
  LATEST_RESULT_MAX_CHARS,
  readLatestAssistantText,
  type LatestAssistantText,
} from "@cjhyy/code-shell-pet/disclosure";
import { createMtimeSessionCache } from "./mtime-session-cache.js";

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
  const readLatest = options?.read ?? readLatestAssistantText;
  const cache = createMtimeSessionCache<LatestAssistantText | null>(
    sessionsRootDir,
    (dir) => readLatest(dir, { maxChars: LATEST_RESULT_MAX_CHARS }),
    options?.maxEntries !== undefined ? { maxEntries: options.maxEntries } : undefined,
  );
  return {
    read: (sessionId) => cache.get(sessionId),
  };
}
