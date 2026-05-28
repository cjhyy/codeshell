import type { FileEditEntry, Message, ToolMessage } from "../types";

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "applypatch",
  "apply_patch",
]);
const WRITE_TOOLS = new Set(["write", "filewrite"]);
const NOTEBOOK_TOOLS = new Set(["notebookedit", "notebook_edit"]);

function countLines(s: unknown): number {
  return typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
}

function parseArgs(t: ToolMessage): Record<string, unknown> {
  // argsLive is the accumulated streaming args (tool_use_args_delta).
  // args is the initial snapshot (tool_use_start) which may be {} when
  // args stream after the start event. Prefer argsLive when available.
  const raw = t.argsLive && Object.keys(t.argsLive).length > 0 ? t.argsLive : t.args;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(t.args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function entryFor(t: ToolMessage): { path: string; added: number; removed: number } | null {
  if (t.status !== "succeeded") return null;
  const name = t.toolName.toLowerCase();
  const args = parseArgs(t);
  const path =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "";
  if (!path) return null;

  if (EDIT_TOOLS.has(name)) {
    return {
      path,
      added: countLines(args.new_string),
      removed: countLines(args.old_string),
    };
  }
  if (WRITE_TOOLS.has(name)) {
    return { path, added: countLines(args.content), removed: 0 };
  }
  if (NOTEBOOK_TOOLS.has(name)) {
    return {
      path,
      added: countLines(args.new_source),
      removed: countLines(args.old_source),
    };
  }
  return null;
}

/**
 * Walk messages from the last user message to the end, collect every
 * successful Edit/Write/NotebookEdit (including subagent toolCalls),
 * merge by path. Returns null when nothing to summarize so the caller
 * skips emitting an empty card.
 */
export function aggregateFileChanges(messages: Message[]): FileEditEntry[] | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const byPath = new Map<string, FileEditEntry>();
  const consume = (raw: { path: string; added: number; removed: number }): void => {
    const existing = byPath.get(raw.path);
    if (existing) {
      existing.added += raw.added;
      existing.removed += raw.removed;
      existing.count += 1;
    } else {
      byPath.set(raw.path, {
        path: raw.path,
        added: raw.added,
        removed: raw.removed,
        count: 1,
      });
    }
  };

  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind === "tool") {
      const e = entryFor(m);
      if (e) consume(e);
    } else if (m.kind === "agent") {
      for (const t of m.toolCalls) {
        const e = entryFor(t);
        if (e) consume(e);
      }
    }
  }

  if (byPath.size === 0) return null;
  return Array.from(byPath.values());
}
