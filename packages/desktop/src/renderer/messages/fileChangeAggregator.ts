import type { FileEditEntry, Message, SessionFileDiff, ToolMessage } from "../types";

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "applypatch",
  "apply_patch",
]);
const WRITE_TOOLS = new Set(["write", "filewrite"]);
const NOTEBOOK_TOOLS = new Set(["notebookedit", "notebook_edit"]);

export function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  // Match linesOf(): a single trailing newline terminates the last line rather
  // than starting a phantom empty one, so "a\nb\n" is 2 lines, not 3.
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return body.split("\n").length;
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

function parseApplyPatch(patch: string): ToolEditChange[] {
  const out: ToolEditChange[] = [];
  let current: {
    path: string;
    status: "modified" | "added" | "deleted";
    lines: string[];
    added: number;
    removed: number;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    if (current.added > 0 || current.removed > 0) {
      const oldStart = current.removed === 0 ? 0 : 1;
      const newStart = current.added === 0 ? 0 : 1;
      out.push({
        path: current.path,
        added: current.added,
        removed: current.removed,
        diff: [
          `diff --git a/${current.path} b/${current.path}`,
          ...(current.status === "added" ? ["new file mode 100644"] : []),
          ...(current.status === "deleted" ? ["deleted file mode 100644"] : []),
          current.status === "added" ? "--- /dev/null" : `--- a/${current.path}`,
          current.status === "deleted" ? "+++ /dev/null" : `+++ b/${current.path}`,
          `@@ -${hunkRange(oldStart, current.removed)} +${hunkRange(newStart, current.added)} @@`,
          ...current.lines,
          "",
        ].join("\n"),
      });
    }
    current = null;
  };

  for (const line of patch.split("\n")) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      flush();
      const kind = fileMatch[1]!;
      current = {
        path: fileMatch[2]!.trim(),
        status: kind === "Add" ? "added" : kind === "Delete" ? "deleted" : "modified",
        lines: [],
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (!current) continue;
    if (line === "*** End Patch" || line.startsWith("*** ")) {
      flush();
      if (line === "*** End Patch") break;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push(line);
      current.added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push(line);
      current.removed += 1;
    } else if (line.startsWith(" ") || line === "") {
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

function entryFor(t: ToolMessage): ToolEditChange | ToolEditChange[] | null {
  if (t.status !== "succeeded") return null;
  const name = t.toolName.toLowerCase();
  const args = parseArgs(t);
  if (name === "applypatch" || name === "apply_patch") {
    const patch = stringOf(args.patch);
    const changes = parseApplyPatch(patch);
    if (changes.length === 0) return null;
    return changes;
  }
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
  const oldLinesAll = linesOf(oldText);
  const newLinesAll = linesOf(newText);

  // Trim the common leading / trailing lines so the diff INTERLEAVES around the
  // actual change instead of dumping the whole old block then the whole new
  // block. A one-line edit then reads as context · -old · +new · context,
  // matching a real unified diff. (An added file has no old side — skip.)
  let pre = 0;
  if (status !== "added") {
    while (
      pre < oldLinesAll.length &&
      pre < newLinesAll.length &&
      oldLinesAll[pre] === newLinesAll[pre]
    ) {
      pre++;
    }
  }
  let post = 0;
  if (status !== "added") {
    while (
      post < oldLinesAll.length - pre &&
      post < newLinesAll.length - pre &&
      oldLinesAll[oldLinesAll.length - 1 - post] === newLinesAll[newLinesAll.length - 1 - post]
    ) {
      post++;
    }
  }
  const oldLines = oldLinesAll.slice(pre, oldLinesAll.length - post);
  const newLines = newLinesAll.slice(pre, newLinesAll.length - post);
  // Up to 3 lines of context on each side, like git's default.
  const ctxBefore = oldLinesAll.slice(Math.max(0, pre - 3), pre);
  const ctxAfter = oldLinesAll.slice(
    oldLinesAll.length - post,
    Math.min(oldLinesAll.length, oldLinesAll.length - post + 3),
  );
  const oldStart = oldLinesAll.length === 0 ? 0 : Math.max(1, pre - ctxBefore.length + 1);
  const newStart = newLinesAll.length === 0 ? 0 : Math.max(1, pre - ctxBefore.length + 1);
  const oldCount = ctxBefore.length + oldLines.length + ctxAfter.length;
  const newCount = ctxBefore.length + newLines.length + ctxAfter.length;
  return [
    `diff --git a/${file} b/${file}`,
    ...(status === "added" ? ["new file mode 100644"] : []),
    status === "added" ? "--- /dev/null" : `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(
      newStart,
      newCount,
    )} @@${hunkIndex ? ` edit ${hunkIndex}` : ""}`,
    ...ctxBefore.map((line) => ` ${line}`),
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    ...ctxAfter.map((line) => ` ${line}`),
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
      if (Array.isArray(e)) e.forEach((change) => consume(m.id, change));
      else if (e) consume(m.id, e);
    } else if (m.kind === "agent") {
      for (const t of m.toolCalls) {
        const e = entryFor(t);
        if (Array.isArray(e)) e.forEach((change) => consume(t.id, change));
        else if (e) consume(t.id, e);
      }
    }
  }

  if (byPath.size === 0) return null;
  return { files: Array.from(byPath.values()), sessionDiffs };
}
