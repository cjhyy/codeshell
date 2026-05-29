import type { FileEditEntry, Message, SessionFileDiff, ToolMessage } from "../types";

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

interface ToolEditChange {
  path: string;
  added: number;
  removed: number;
  diff: string;
}

function entryFor(t: ToolMessage): ToolEditChange | null {
  if (t.status !== "succeeded") return null;
  const name = t.toolName.toLowerCase();
  const args = parseArgs(t);
  const path =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "";
  if (!path) return null;

  if (EDIT_TOOLS.has(name)) {
    if (Array.isArray(args.edits)) {
      const pieces = args.edits
        .map((edit) => {
          if (!edit || typeof edit !== "object") return null;
          const record = edit as Record<string, unknown>;
          return {
            oldText: stringOf(record.old_string),
            newText: stringOf(record.new_string),
          };
        })
        .filter((edit): edit is { oldText: string; newText: string } => edit !== null);
      if (pieces.length > 0) {
        return {
          path,
          added: pieces.reduce((sum, edit) => sum + countLines(edit.newText), 0),
          removed: pieces.reduce((sum, edit) => sum + countLines(edit.oldText), 0),
          diff: pieces
            .map((edit, i) => syntheticSnippetDiff(path, edit.oldText, edit.newText, undefined, i + 1))
            .join("\n"),
        };
      }
    }
    const oldText = stringOf(args.old_string);
    const newText = stringOf(args.new_string);
    return {
      path,
      added: countLines(newText),
      removed: countLines(oldText),
      diff: syntheticSnippetDiff(path, oldText, newText),
    };
  }
  if (WRITE_TOOLS.has(name)) {
    const content = stringOf(args.content);
    return {
      path,
      added: countLines(content),
      removed: 0,
      diff: syntheticSnippetDiff(path, "", content, "added"),
    };
  }
  if (NOTEBOOK_TOOLS.has(name)) {
    const oldText = stringOf(args.old_source);
    const newText = stringOf(args.new_source);
    return {
      path,
      added: countLines(newText),
      removed: countLines(oldText),
      diff: syntheticSnippetDiff(path, oldText, newText),
    };
  }
  return null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function linesOf(text: string): string[] {
  if (!text) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function syntheticSnippetDiff(
  file: string,
  oldText: string,
  newText: string,
  status: "modified" | "added" = "modified",
  hunkIndex?: number,
): string {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `diff --git a/${file} b/${file}`,
    ...(status === "added" ? ["new file mode 100644"] : []),
    status === "added" ? "--- /dev/null" : `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkRange(oldStart, oldLines.length)} +${hunkRange(
      newStart,
      newLines.length,
    )} @@${hunkIndex ? ` edit ${hunkIndex}` : ""}`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/**
 * Walk messages from the last user message to the end, collect every
 * successful Edit/Write/NotebookEdit (including subagent toolCalls),
 * merge by path. Returns null when nothing to summarize so the caller
 * skips emitting an empty card.
 */
export function aggregateFileChanges(messages: Message[]): FileEditEntry[] | null {
  return aggregateFileChangeSummary(messages)?.files ?? null;
}

export function aggregateFileChangeSummary(
  messages: Message[],
): { files: FileEditEntry[]; sessionDiffs: SessionFileDiff[] } | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === "user") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const byPath = new Map<string, FileEditEntry>();
  const sessionDiffs: SessionFileDiff[] = [];
  const consume = (toolCallId: string, raw: ToolEditChange): void => {
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
    if (raw.diff.trim()) {
      sessionDiffs.push({ path: raw.path, toolCallId, diff: raw.diff });
    }
  };

  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind === "tool") {
      const e = entryFor(m);
      if (e) consume(m.id, e);
    } else if (m.kind === "agent") {
      for (const t of m.toolCalls) {
        const e = entryFor(t);
        if (e) consume(t.id, e);
      }
    }
  }

  if (byPath.size === 0) return null;
  return { files: Array.from(byPath.values()), sessionDiffs };
}
