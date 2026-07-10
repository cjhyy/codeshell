import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { encodeCwd } from "./session-discovery.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** `summary` is a lossy one-field preview; `args` is the full tool_use input
   *  (e.g. a sub-agent's `prompt`) so a replayed tool card can show the real
   *  parameters, not just the whitelisted field. */
  tools?: { name: string; summary: string; args?: Record<string, unknown> }[];
  ts?: number;
}

/** One render-relevant event parsed from an appended external-CLI transcript
 * line. Kept CLI-neutral so the desktop room follower can feed Claude Code and
 * Codex through the same RoomManager push path. */
export type SessionTailEvent =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      id?: string;
      name: string;
      summary: string;
      args?: Record<string, unknown>;
    }
  | { type: "tool_result"; id?: string; result: string; isError: boolean }
  | { type: "turn_end"; reason: string };

const NOISE = ["<local-command-caveat>", "<command-name>"];
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}
function toolsOf(
  content: unknown,
): { name: string; summary: string; args?: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; summary: string; args?: Record<string, unknown> }[] = [];
  for (const p of content as any[]) {
    if (p?.type === "tool_use") {
      const inp = p.input ?? {};
      const summary =
        inp.command ?? inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ?? inp.query ?? "";
      const args = inp && typeof inp === "object" && Object.keys(inp).length > 0 ? inp : undefined;
      out.push({
        name: typeof p.name === "string" ? p.name : "tool",
        summary: String(summary).slice(0, 120),
        args,
      });
    }
  }
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
    )
    .join("");
}

/** Parse a bounded/raw Claude Code transcript snapshot. Exported so a live
 * follower can take its initial snapshot and EOF cursor from the same read,
 * eliminating the snapshot→subscribe race. */
export function parseRecentHistory(
  raw: string,
  limit: number,
): { messages: HistoryMessage[]; hasMore: boolean; totalCount: number } {
  const all: HistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "user") {
      const t = textOf(d.message?.content).trim();
      if (!t || NOISE.some((n) => t.startsWith(n))) continue;
      all.push({ role: "user", text: t });
    } else if (d.type === "assistant") {
      const t = textOf(d.message?.content).trim();
      const tools = toolsOf(d.message?.content);
      if (!t && tools.length === 0) continue;
      all.push({ role: "assistant", text: t, tools: tools.length ? tools : undefined });
    }
  }
  const lim = limit > 0 ? limit : 20;
  const start = Math.max(0, all.length - lim);
  return { messages: all.slice(start), hasMore: start > 0, totalCount: all.length };
}

/** Parse one newly-appended Claude Code transcript JSONL line into the compact
 * event vocabulary consumed by the desktop room follower. */
export function parseClaudeTranscriptLine(line: string): SessionTailEvent[] {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  const out: SessionTailEvent[] = [];
  if (d.type === "user") {
    const content = d.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== "tool_result") continue;
        out.push({
          type: "tool_result",
          id: typeof part.tool_use_id === "string" ? part.tool_use_id : undefined,
          result: toolResultText(part.content).slice(0, 4000),
          isError: Boolean(part.is_error),
        });
      }
    }
    const text = textOf(content).trim();
    if (text && !NOISE.some((noise) => text.startsWith(noise))) {
      out.unshift({ type: "user", text });
    }
    return out;
  }
  if (d.type === "assistant" && Array.isArray(d.message?.content)) {
    for (const part of d.message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        out.push({ type: "assistant", text: part.text });
      } else if (part?.type === "tool_use") {
        const input =
          part.input && typeof part.input === "object"
            ? (part.input as Record<string, unknown>)
            : undefined;
        out.push({
          type: "tool",
          id: typeof part.id === "string" ? part.id : undefined,
          name: typeof part.name === "string" ? part.name : "tool",
          summary: toolsOf([part])[0]?.summary ?? "",
          args: input,
        });
      }
    }
    if (d.message.stop_reason === "end_turn") {
      out.push({ type: "turn_end", reason: "completed" });
    }
    return out;
  }
  if (d.type === "result") {
    return [
      {
        type: "turn_end",
        reason: typeof d.subtype === "string" ? d.subtype : "completed",
      },
    ];
  }
  return [];
}

/** Read the last `limit` user/assistant messages from a claude session jsonl. */
export function readRecentHistory(
  cwd: string,
  sessionId: string,
  limit: number,
  claudeHome = join(homedir(), ".claude"),
): { messages: HistoryMessage[]; hasMore: boolean; totalCount: number } {
  const file = join(claudeHome, "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
  if (!existsSync(file)) return { messages: [], hasMore: false, totalCount: 0 };
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return { messages: [], hasMore: false, totalCount: 0 };
  }
  return parseRecentHistory(raw, limit);
}
