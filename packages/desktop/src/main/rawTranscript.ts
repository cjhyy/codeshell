/**
 * Read the on-disk transcript as raw events, preserving the cursor fields
 * (id / turnNumber / timestamp) that the folded reader discards.
 *
 * This is the long-disconnect fallback: when the main process's in-memory
 * snapshot window has evicted old events, a renderer can re-read the disk
 * transcript from a known event `id` and resume without gaps or duplicates.
 * The disk `id` is the stable dedup key (live StreamEvents have none).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const SESSIONS_DIR = path.join(os.homedir(), ".code-shell", "sessions");
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export interface RawTranscriptEvent {
  id: string;
  type: string;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

/**
 * Parse newline-delimited transcript JSON into raw events. With `sinceId`,
 * returns only events strictly after the first one whose id matches (exclusive);
 * if `sinceId` is absent or not found, returns all events. Malformed lines are
 * skipped, mirroring core's Transcript.loadFromFile.
 */
export function parseRawTranscriptEvents(jsonl: string, sinceId?: string): RawTranscriptEvent[] {
  const all: RawTranscriptEvent[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      all.push(JSON.parse(line) as RawTranscriptEvent);
    } catch {
      continue;
    }
  }
  if (!sinceId) return all;
  const idx = all.findIndex((e) => e.id === sinceId);
  return idx >= 0 ? all.slice(idx + 1) : all;
}

/**
 * Read + parse raw transcript events for `sessionId`. `baseDir` overridable for
 * tests; defaults to ~/.code-shell/sessions. Returns [] when absent/empty.
 */
export async function getSessionEvents(
  sessionId: string,
  sinceId?: string,
  baseDir: string = SESSIONS_DIR,
): Promise<RawTranscriptEvent[]> {
  if (!SAFE_ID.test(sessionId) || sessionId === "." || sessionId === "..") return [];
  const file = path.join(baseDir, sessionId, "transcript.jsonl");
  try {
    const jsonl = await fs.readFile(file, "utf8");
    return parseRawTranscriptEvents(jsonl, sinceId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
