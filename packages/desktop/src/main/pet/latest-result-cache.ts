/**
 * Mtime-keyed cache over the disclosure latest-result reader. One entry per
 * session; bounded so a long-lived main process cannot grow unboundedly.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  readLatestAssistantText,
  type LatestAssistantText,
} from "@cjhyy/code-shell-pet/disclosure";

const MAX_ENTRIES = 200;
const MAX_CHARS = 2_000;

export function createLatestResultCache(sessionsRootDir: string): {
  read(sessionId: string): Promise<LatestAssistantText | null>;
} {
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
      if (cached && cached.mtimeMs === mtimeMs) return cached.value;
      const value = await readLatestAssistantText(dir, { maxChars: MAX_CHARS }).catch(() => null);
      cache.delete(sessionId);
      cache.set(sessionId, { mtimeMs, value });
      if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    },
  };
}
