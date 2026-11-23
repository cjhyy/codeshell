import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { DesktopSessionSummary } from "./sessions-service.js";

export const MAX_HISTORY_STATE_BYTES = 2 * 1024 * 1024;
export function isHistorySessionId(id: string) {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(id) &&
    !id.includes("..") &&
    !id.startsWith("qchat-") &&
    !id.startsWith("panel-task-")
  );
}

type HistoryEntry = Pick<Dirent, "name" | "isFile" | "isDirectory">;

export function historyEntryId(entry: HistoryEntry): string | undefined {
  if (!entry.isDirectory() && (!entry.isFile() || !/\.jsonl?$/.test(entry.name))) return;
  const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.jsonl?$/, "");
  return isHistorySessionId(id) ? id : undefined;
}

export async function readHistorySummary(
  entry: HistoryEntry,
  baseDir: string,
): Promise<DesktopSessionSummary | null> {
  const directory = entry.isDirectory();
  const id = historyEntryId(entry);
  if (!id) return null;

  try {
    const file = path.join(baseDir, entry.name, ...(directory ? ["state.json"] : []));
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const summary: DesktopSessionSummary = {
      id,
      file,
      size: info.size,
      createdAt: info.birthtimeMs || info.mtimeMs,
      updatedAt: info.mtimeMs,
    };
    if (!directory) return summary;
    if (info.size > MAX_HISTORY_STATE_BYTES) return null;
    const state = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown> | null;
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    // History includes archived/legacy sessions, but internal conversations
    // and temporary forks must stay out of the user-facing catalog.
    if (state.ephemeral === true || state.kind === "pet" || state.parentSessionId) return null;
    const title = typeof state.title === "string" && state.title ? state.title : state.summary;
    if (typeof title === "string" && title) summary.title = title.slice(0, 1024);
    if (typeof state.startedAt === "number" && Number.isFinite(new Date(state.startedAt).getTime()))
      summary.createdAt = state.startedAt;
    const transcript = path.join(baseDir, id, "transcript.jsonl");
    try {
      const transcriptInfo = await fs.lstat(transcript);
      if (!transcriptInfo.isFile() || transcriptInfo.isSymbolicLink()) return null;
      summary.file = transcript;
      summary.size += transcriptInfo.size;
      summary.updatedAt = Math.max(info.mtimeMs, transcriptInfo.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A newly persisted session may not have a transcript yet.
    }
    return summary;
  } catch {
    // One corrupt/unreadable session or a concurrent delete cannot hide the rest.
    return null;
  }
}
