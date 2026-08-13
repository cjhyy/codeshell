/**
 * Read the on-disk transcript as raw events, preserving the cursor fields
 * (id / turnNumber / timestamp) that the folded reader discards.
 *
 * This is the long-disconnect fallback: when the main process's in-memory
 * snapshot window has evicted old events, a renderer can re-read the disk
 * transcript from a known event `id` and resume without gaps or duplicates.
 * The disk `id` is the stable dedup key (live StreamEvents have none).
 */
import { sessionsRoot } from "@cjhyy/code-shell-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const MAX_TRANSCRIPT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_RAW_TRANSCRIPT_EVENTS = 20_000;

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
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const event = parsed as Record<string, unknown>;
      if (
        typeof event.id !== "string" ||
        !event.id ||
        event.id.length > 512 ||
        event.id.includes("\0") ||
        typeof event.type !== "string" ||
        !event.type ||
        event.type.length > 256 ||
        typeof event.timestamp !== "number" ||
        !Number.isFinite(event.timestamp) ||
        typeof event.turnNumber !== "number" ||
        !Number.isSafeInteger(event.turnNumber) ||
        event.turnNumber < 0 ||
        !event.data ||
        typeof event.data !== "object" ||
        Array.isArray(event.data)
      ) {
        continue;
      }
      all.push(event as unknown as RawTranscriptEvent);
      if (all.length > MAX_RAW_TRANSCRIPT_EVENTS * 2) {
        all.splice(0, all.length - MAX_RAW_TRANSCRIPT_EVENTS);
      }
    } catch {
      continue;
    }
  }
  const bounded = all.slice(-MAX_RAW_TRANSCRIPT_EVENTS);
  if (!sinceId) return bounded;
  const idx = bounded.findIndex((e) => e.id === sinceId);
  return idx >= 0 ? bounded.slice(idx + 1) : bounded;
}

async function readTranscriptTail(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("transcript is not a regular file");
    const length = Math.min(stat.size, MAX_TRANSCRIPT_SCAN_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    let window = buffer.subarray(0, total);
    if (start > 0) {
      const newline = window.indexOf(0x0a);
      if (newline < 0) return "";
      window = window.subarray(newline + 1);
    }
    return window.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Read + parse raw transcript events for `sessionId`. `baseDir` overridable for
 * tests; defaults to core's CODE_SHELL_HOME-aware sessions root. Returns []
 * when absent/empty.
 */
export async function getSessionEvents(
  sessionId: string,
  sinceId?: string,
  baseDir: string = sessionsRoot(),
): Promise<RawTranscriptEvent[]> {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    !SAFE_ID.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".." ||
    (sinceId !== undefined &&
      (typeof sinceId !== "string" || sinceId.length > 512 || sinceId.includes("\0")))
  ) {
    return [];
  }
  const file = path.join(baseDir, sessionId, "transcript.jsonl");
  try {
    const sessionInfo = await fs.lstat(path.join(baseDir, sessionId));
    if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) return [];
    const fileInfo = await fs.lstat(file);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return [];
    const jsonl = await readTranscriptTail(file);
    return parseRawTranscriptEvents(jsonl, sinceId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
