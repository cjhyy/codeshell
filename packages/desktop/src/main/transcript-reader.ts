/**
 * Read a persisted engine transcript (~/.code-shell/sessions/<id>/transcript.jsonl)
 * and convert it to an ordered list of FoldItems the renderer can replay
 * through its existing message reducer. Pure parse — no reducer here, so the
 * renderer stays the single source of message-folding logic.
 *
 * TranscriptEvent shape: packages/core/src/types.ts:84-90.
 * StreamEvent shapes:     packages/core/src/types.ts:241-271.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { FoldItem } from "../preload/types";
import type { ContentBlock } from "@cjhyy/code-shell-core";

const SESSIONS_DIR = path.join(os.homedir(), ".code-shell", "sessions");

interface TranscriptEvent {
  id: string;
  type: string;
  timestamp: number;
  turnNumber: number;
  data: Record<string, unknown>;
}

interface ContentBlockLike {
  type?: string;
  text?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlockLike[])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  }
  return "";
}

export function transcriptToFoldItems(jsonl: string): FoldItem[] {
  const items: FoldItem[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ev: TranscriptEvent;
    try {
      ev = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue; // skip malformed lines, mirroring core Transcript.loadFromFile
    }
    const d = ev.data ?? {};
    // Real wall-clock the event was persisted at — carried onto each FoldItem so
    // replay can stamp the original createdAt/doneAt (proper "asked at / answered
    // at / elapsed") instead of leaving them blank (which read as 0s elapsed).
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : undefined;
    switch (ev.type) {
      case "session_meta":
        items.push({
          kind: "stream",
          event: { type: "session_started", sessionId: String(d.sessionId ?? ""), promptTokens: 0 },
          timestamp: ts,
        });
        break;
      case "message": {
        const role = String(d.role ?? "");
        if (role === "user") {
          items.push({ kind: "user", text: textOf(d.content), timestamp: ts });
        } else if (role === "assistant") {
          items.push({ kind: "stream", event: { type: "stream_request_start", turnNumber: ev.turnNumber }, timestamp: ts });
          items.push({ kind: "stream", event: { type: "text_delta", text: textOf(d.content) }, timestamp: ts });
          items.push({
            kind: "stream",
            event: { type: "assistant_message", message: { role: "assistant", content: d.content as string | ContentBlock[] } },
            timestamp: ts,
          });
        }
        break;
      }
      case "tool_use":
        items.push({
          kind: "stream",
          event: {
            type: "tool_use_start",
            toolCall: {
              id: String(d.toolCallId ?? ""),
              toolName: String(d.toolName ?? ""),
              args: (d.args ?? {}) as Record<string, unknown>,
            },
          },
          timestamp: ts,
        });
        break;
      case "tool_result":
        items.push({
          kind: "stream",
          event: {
            type: "tool_result",
            result: {
              id: String(d.toolCallId ?? ""),
              toolName: String(d.toolName ?? ""),
              result: d.result as string | undefined,
              error: d.error as string | undefined,
              isError: d.isError as boolean | undefined,
            },
          },
          timestamp: ts,
        });
        break;
      case "turn_boundary":
        items.push({ kind: "stream", event: { type: "turn_complete", reason: "completed" }, timestamp: ts });
        break;
      case "summary":
        items.push({ kind: "stream", event: { type: "context_compact", strategy: "summary", before: 0, after: 0 }, timestamp: ts });
        break;
      case "error":
        items.push({ kind: "stream", event: { type: "error", error: String(d.error ?? "error") }, timestamp: ts });
        break;
      // session lifecycle events with no renderer representation are ignored.
    }
  }
  return items;
}

/**
 * Read + convert the transcript for `sessionId`. `baseDir` overridable for
 * tests; defaults to ~/.code-shell/sessions. Returns [] when absent/empty.
 */
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export async function getSessionTranscript(
  sessionId: string,
  baseDir: string = SESSIONS_DIR,
): Promise<FoldItem[]> {
  if (!SAFE_ID.test(sessionId) || sessionId === "." || sessionId === "..") return [];
  const file = path.join(baseDir, sessionId, "transcript.jsonl");
  try {
    const jsonl = await fs.readFile(file, "utf8");
    return transcriptToFoldItems(jsonl);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
