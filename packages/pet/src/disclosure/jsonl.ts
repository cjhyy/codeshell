/**
 * Tail-read a JSONL transcript without loading unbounded files: files larger
 * than TAIL_BYTES read only the last TAIL_BYTES and drop the first partial
 * line. Malformed lines are skipped (mirrors core Transcript.loadFromFile).
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

const TAIL_BYTES = 512 * 1024;

export interface DiskTranscriptEvent {
  id?: string;
  type?: string;
  timestamp?: number;
  turnNumber?: number;
  data?: Record<string, unknown>;
}

export async function readTranscriptTail(transcriptPath: string): Promise<DiskTranscriptEvent[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let start: number;
  let text: string;
  try {
    const parent = dirname(transcriptPath);
    const before = await lstat(parent);
    if (!before.isDirectory()) return [];
    handle = await open(
      transcriptPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat();
    const [file, directory] = await Promise.all([lstat(transcriptPath), lstat(parent)]);
    if (
      !file.isFile() ||
      !opened.isFile() ||
      !directory.isDirectory() ||
      file.dev !== opened.dev ||
      file.ino !== opened.ino ||
      directory.dev !== before.dev ||
      directory.ino !== before.ino
    )
      return [];
    start = Math.max(0, opened.size - TAIL_BYTES);
    const buffer = Buffer.alloc(opened.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  const events: DiskTranscriptEvent[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as DiskTranscriptEvent;
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(block) &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}
