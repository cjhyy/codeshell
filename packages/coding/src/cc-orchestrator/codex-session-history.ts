import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HistoryMessage, SessionTailEvent } from "./session-history.js";

/**
 * Read the last `limit` user/assistant messages from a codex CLI session,
 * returning the SAME shape as the claude-side `readRecentHistory` so the room
 * UI stays CLI-blind.
 *
 * Codex storage differs from claude fundamentally (see `codex-session-discovery`):
 * rollouts live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, keyed by
 * DATE not cwd, with the thread id inside the file's `session_meta` first line.
 * So we first locate the rollout file whose `session_meta` matches both
 * `threadId` and `cwd`, then parse its event stream:
 *
 *   - {type:"response_item", payload:{type:"message", role:"user"|"assistant",
 *        content:[{type:"input_text"|"output_text", text}]}}  → message text
 *   - {type:"response_item", payload:{type:"function_call", name, arguments}}   → tool
 *   - {type:"response_item", payload:{type:"custom_tool_call", name, input}}    → tool
 *
 * `developer`-role messages (environment/system injections) and the leading
 * `<environment_context>` user wrapper are skipped, mirroring discovery.
 */
/** Read recent Codex CLI history for the coding host. */
export function readCodexRecentHistory(
  cwd: string,
  threadId: string,
  limit: number,
  codexHome = join(homedir(), ".codex"),
): { messages: HistoryMessage[]; hasMore: boolean; totalCount: number } {
  const empty = { messages: [] as HistoryMessage[], hasMore: false, totalCount: 0 };
  const file = findCodexRolloutFile(codexHome, cwd, threadId);
  if (!file) return empty;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return empty;
  }

  return parseCodexRecentHistory(raw, limit);
}

/** Parse a bounded/raw Codex rollout snapshot. Shared with the desktop tail
 * follower so its initial history and EOF cursor are atomic. */
export function parseCodexRecentHistory(
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
    if (d?.type !== "response_item") continue;
    const p = d.payload;
    if (!p) continue;

    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const t = textOf(p.content).trim();
      if (!t || t.startsWith("<environment_context>")) continue;
      all.push({ role: p.role, text: t });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const tool = {
        name: typeof p.name === "string" ? p.name : "tool",
        summary: summaryOf(p),
        args: argsOf(p),
      };
      const last = all[all.length - 1];
      // Attach the tool to the preceding assistant turn; otherwise start one.
      if (last && last.role === "assistant") {
        (last.tools ??= []).push(tool);
      } else {
        all.push({ role: "assistant", text: "", tools: [tool] });
      }
    }
  }

  const lim = limit > 0 ? limit : 20;
  const start = Math.max(0, all.length - lim);
  return { messages: all.slice(start), hasMore: start > 0, totalCount: all.length };
}

/** Parse one newly-appended Codex rollout JSONL line. `response_item` is the
 * authoritative rendered stream; parallel `event_msg.agent_message` records
 * are deliberately ignored to avoid duplicate assistant bubbles. */
export function parseCodexTranscriptLine(line: string): SessionTailEvent[] {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  if (d?.type === "event_msg" && d.payload?.type === "task_complete") {
    return [{ type: "turn_end", reason: "completed" }];
  }
  if (d?.type !== "response_item" || !d.payload) return [];
  const p = d.payload;
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const text = textOf(p.content).trim();
    if (!text || text.startsWith("<environment_context>")) return [];
    return [{ type: p.role === "user" ? "user" : "assistant", text }];
  }
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    return [
      {
        type: "tool",
        id: typeof p.call_id === "string" ? p.call_id : undefined,
        name: typeof p.name === "string" ? p.name : "tool",
        summary: summaryOf(p),
        args: argsOf(p),
      },
    ];
  }
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    const result =
      typeof p.output === "string"
        ? p.output
        : typeof p.content === "string"
          ? p.content
          : JSON.stringify(p.output ?? p.content ?? "");
    return [
      {
        type: "tool_result",
        id: typeof p.call_id === "string" ? p.call_id : undefined,
        result: result.slice(0, 4000),
        isError: Boolean(p.is_error),
      },
    ];
  }
  return [];
}

/** Join the text of codex content parts (`input_text`/`output_text`). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
  return "";
}

/** Build a short summary for a codex tool event from its arguments/input. */
function summaryOf(payload: any): string {
  // function_call carries `arguments` as a JSON string; custom_tool_call carries `input` as a string.
  if (typeof payload.arguments === "string") {
    try {
      const a = JSON.parse(payload.arguments);
      const s = a?.cmd ?? a?.command ?? a?.file_path ?? a?.path ?? a?.workdir ?? "";
      if (s) return String(s).slice(0, 120);
    } catch {
      /* fall through to raw */
    }
    return payload.arguments.slice(0, 120);
  }
  if (typeof payload.input === "string") return payload.input.slice(0, 120);
  return "";
}

/**
 * Build the FULL structured tool args for a codex tool event so a replayed tool
 * card can show the real parameters (not just the lossy one-field summary).
 * `function_call.arguments` is a JSON string → parse it; `custom_tool_call.input`
 * is a raw string → keep it under `{input}`. Returns undefined when neither is
 * present or the JSON is malformed.
 */
function argsOf(payload: any): Record<string, unknown> | undefined {
  if (typeof payload.arguments === "string") {
    try {
      const a = JSON.parse(payload.arguments);
      if (a && typeof a === "object") return a as Record<string, unknown>;
    } catch {
      /* malformed JSON → fall through */
    }
    return { arguments: payload.arguments };
  }
  if (typeof payload.input === "string") return { input: payload.input };
  return undefined;
}

/** Find the rollout file whose `session_meta` matches both `threadId` and `cwd`. */
export function findCodexRolloutFile(
  codexHome: string,
  cwd: string,
  threadId: string,
): string | undefined {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return undefined;
  for (const file of walkRollouts(root)) {
    let meta: { id?: string; cwd?: string } | undefined;
    try {
      meta = readSessionMeta(file);
    } catch {
      continue;
    }
    if (meta && meta.id === threadId && meta.cwd === cwd) return file;
  }
  return undefined;
}

/** Recursively yield every `rollout-*.jsonl` file under `root`. */
function* walkRollouts(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkRollouts(full);
    } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

/** Parse the first-line `session_meta` event → `{ id, cwd }`, reading a bounded prefix. */
function readSessionMeta(
  file: string,
  maxBytes = 1 << 16,
): { id?: string; cwd?: string } | undefined {
  const fd = openSync(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    text = buf.toString("utf-8", 0, n);
  } finally {
    closeSync(fd);
  }
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (!first) return undefined;
  const d = JSON.parse(first) as { type?: string; payload?: { id?: string; cwd?: string } };
  if (d.type !== "session_meta" || !d.payload) return undefined;
  return { id: d.payload.id, cwd: d.payload.cwd };
}
