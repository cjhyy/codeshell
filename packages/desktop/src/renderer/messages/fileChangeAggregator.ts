import type { TurnDiffSnapshot } from "@cjhyy/code-shell-core";
import type { FileEditEntry, Message, SessionFileDiff, ToolMessage } from "../types";
import {
  composeFileEdits,
  syntheticSnippetDiff,
  type FileEditOperation,
} from "../diff/composeFileEdits";

const EDIT_TOOLS = new Set(["edit", "multiedit", "applypatch", "apply_patch"]);
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
  operations?: FileEditOperation[];
}

interface ExternalFileChange {
  sourceId: string;
  path: string;
  identity: string;
}

function normalizeFilePath(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const drive = slash
    .match(/^[A-Za-z]:\//)?.[0]
    ?.slice(0, 2)
    .toUpperCase();
  const absolute = slash.startsWith("/") || drive !== undefined;
  const unc = slash.startsWith("//");
  const body = drive ? slash.slice(3) : slash.startsWith("/") ? slash.slice(1) : slash;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? `${drive}/` : unc ? "//" : absolute ? "/" : "";
  return `${prefix}${parts.join("/")}` || (absolute ? prefix : ".");
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function resolveFilePath(cwd: string, path: string): string {
  const normalized = normalizeFilePath(path);
  if (isAbsoluteFilePath(normalized)) return normalized;
  return normalizeFilePath(`${normalizeFilePath(cwd)}/${normalized}`);
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
            replaceAll: record.replace_all === true,
          };
        })
        .filter((edit): edit is NonNullable<typeof edit> => edit !== null);
      if (pieces.length > 0) {
        return {
          path,
          added: pieces.reduce((sum, edit) => sum + countLines(edit.newText), 0),
          removed: pieces.reduce((sum, edit) => sum + countLines(edit.oldText), 0),
          diff: pieces
            .map((edit, i) =>
              syntheticSnippetDiff(path, edit.oldText, edit.newText, undefined, i + 1),
            )
            .join("\n"),
          operations: pieces.map((edit) => ({ kind: "edit", ...edit })),
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
      operations: [{ kind: "edit", oldText, newText, replaceAll: args.replace_all === true }],
    };
  }
  if (WRITE_TOOLS.has(name)) {
    const content = stringOf(args.content);
    return {
      path,
      added: countLines(content),
      removed: 0,
      diff: syntheticSnippetDiff(path, "", content, "added"),
      operations: [{ kind: "write", content }],
    };
  }
  if (NOTEBOOK_TOOLS.has(name)) {
    if (args.action === "read") return null;
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

function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
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
): { files: FileEditEntry[]; sessionDiffs: SessionFileDiff[]; unresolvedPaths?: string[] } | null {
  // Find the last REAL user turn. Engine-injected user messages (step-gap
  // steering / goal wakeup continuation, marked injected) are transparent: a
  // goal-driven task spans many engine.run boundaries — each inserts an injected
  // user turn — and the summary must cover ALL its edits, not just the final
  // run's. Skipping them lands the boundary on the last thing the user actually
  // typed (TODO-background-panel #9).
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "user" && !m.injected) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const boundary = messages[start];
  const boundaryClientMessageId = boundary.kind === "user" ? boundary.clientMessageId : undefined;

  // Execution snapshots replace previews for every tracked path, including
  // paths absent from files because the turn restored their original content.
  const snapshots = new Map<string, TurnDiffSnapshot>();
  const snapshotCapturedAt = new Map<string, number | undefined>();
  for (const message of messages.slice(start + 1)) {
    if (message.kind === "system" && message.turnDiff) {
      const snapshot = message.turnDiff;
      if (
        boundary.kind === "user" &&
        boundary.sourceEventId &&
        snapshot.turnId !== boundary.sourceEventId
      )
        continue;
      snapshots.set(snapshot.turnId, snapshot);
      snapshotCapturedAt.set(snapshot.turnId, message.turnDiffCapturedAt);
    }
  }
  const trackedPaths = new Set<string>();
  const trackedToolCallIds = new Set<string>();
  const capturedAtByPath = new Map<string, number | undefined>();
  for (const snapshot of snapshots.values()) {
    snapshot.trackedPaths.forEach((path) => {
      const identity = resolveFilePath(snapshot.cwd, path);
      trackedPaths.add(identity);
      capturedAtByPath.set(identity, snapshotCapturedAt.get(snapshot.turnId));
    });
    snapshot.toolCallIds.forEach((id) => trackedToolCallIds.add(id));
  }
  const executionCwd = Array.from(snapshots.values()).at(-1)?.cwd;
  const toolIdentity = (path: string) =>
    executionCwd ? resolveFilePath(executionCwd, path) : normalizeFilePath(path);
  const executionTouchCounts = new Map<string, Set<string>>();
  // Detached children can finish after a parent capture. Retain their operation
  // evidence until execution publishes a newer aggregate; never call stale bytes final.
  const unresolvedPaths = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (message.kind !== "agent") continue;
    for (const tool of message.toolCalls) {
      if (trackedToolCallIds.has(tool.id)) continue;
      const changes = entryFor({ ...tool, status: "succeeded" });
      for (const change of Array.isArray(changes) ? changes : changes ? [changes] : []) {
        const identity = toolIdentity(change.path);
        if (!trackedPaths.has(identity)) continue;
        const capturedAt = capturedAtByPath.get(identity);
        if (capturedAt === undefined || tool.endedAt === undefined || tool.endedAt >= capturedAt)
          unresolvedPaths.add(identity);
      }
    }
  }

  // External completion carries its own cwd. Keep that absolute identity for
  // display/open targets; a relative tool path has no caller-cwd evidence and
  // must not be attributed to whichever external root happens to match first.
  const externalFiles: ExternalFileChange[] = [];
  const externalIdentities = new Set<string>();
  const seenExternalAttribution = new Set<string>();
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind !== "system" || !m.externalFileChanges) continue;
    const { sourceId, cwd, files } = m.externalFileChanges;
    if (
      m.externalFileChanges.originClientMessageId !== undefined &&
      m.externalFileChanges.originClientMessageId !== boundaryClientMessageId
    ) {
      continue;
    }
    for (const path of files) {
      if (typeof path !== "string" || !path) continue;
      const identity = resolveFilePath(cwd, path);
      const attributionKey = `${sourceId}\0${identity}`;
      if (seenExternalAttribution.has(attributionKey)) continue;
      seenExternalAttribution.add(attributionKey);
      externalIdentities.add(identity);
      externalFiles.push({
        sourceId,
        path,
        identity,
      });
    }
  }

  const byPath = new Map<string, FileEditEntry>();
  const operationsByPath = new Map<
    string,
    {
      firstToolCallId: string;
      operations: FileEditOperation[];
      previews: FileEditOperation[];
      writers: Set<string | null>;
    }
  >();
  const consume = (
    toolCallId: string,
    raw: ToolEditChange,
    writer: string | null,
    identity = normalizeFilePath(raw.path),
    displayPath = normalizeFilePath(raw.path),
  ): void => {
    const existing = byPath.get(identity);
    if (existing) {
      existing.added += raw.added;
      existing.removed += raw.removed;
      existing.count += 1;
    } else {
      byPath.set(identity, {
        path: displayPath,
        added: raw.added,
        removed: raw.removed,
        count: 1,
      });
    }
    const operations =
      raw.operations ?? (raw.diff.trim() ? [{ kind: "opaque" as const, diff: raw.diff }] : []);
    if (operations.length) {
      const previous = operationsByPath.get(identity);
      const previews: FileEditOperation[] = raw.diff.trim()
        ? [{ kind: "opaque", diff: raw.diff }]
        : [];
      if (previous) {
        previous.operations.push(...operations);
        previous.previews.push(...previews);
        previous.writers.add(writer);
      } else
        operationsByPath.set(identity, {
          firstToolCallId: toolCallId,
          operations: [...operations],
          previews,
          writers: new Set([writer]),
        });
    }
  };

  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind === "tool") {
      const e = entryFor(m);
      for (const change of Array.isArray(e) ? e : e ? [e] : []) {
        const identity = toolIdentity(change.path);
        if (
          !unresolvedPaths.has(identity) &&
          (trackedToolCallIds.has(m.id) || trackedPaths.has(identity))
        ) {
          const ids = executionTouchCounts.get(identity) ?? new Set<string>();
          ids.add(m.id);
          executionTouchCounts.set(identity, ids);
          continue;
        }
        consume(m.id, change, null, identity);
      }
    } else if (m.kind === "agent") {
      for (const t of m.toolCalls) {
        const e = entryFor(t);
        for (const change of Array.isArray(e) ? e : e ? [e] : []) {
          const identity = toolIdentity(change.path);
          if (
            unresolvedPaths.has(identity) ||
            (!trackedToolCallIds.has(t.id) && !trackedPaths.has(identity))
          )
            consume(t.id, change, m.id, identity);
        }
      }
    }
  }

  for (const external of externalFiles) {
    if (trackedPaths.has(external.identity)) continue;
    consume(
      `external:${external.sourceId}`,
      { path: external.path, added: 0, removed: 0, diff: "" },
      null,
      external.identity,
      external.identity,
    );
  }

  const sessionDiffs: SessionFileDiff[] = [];
  for (const [identity, source] of operationsByPath) {
    const entry = byPath.get(identity)!;
    // Agent tools are backfilled into the agent's earlier message card. Card
    // order therefore cannot establish the order of edits from different
    // writers; wall-clock tool timestamps cannot prove that order either.
    // Keep each recorded preview instead of guessing a final file version.
    const composed = composeFileEdits(
      entry.path,
      source.writers.size > 1 ? source.previews : source.operations,
    );
    // A successful edit followed by its exact reversal has no net change.
    // Keep external-only attribution when no payload can establish its result.
    if (!composed.diff && !externalIdentities.has(identity)) {
      byPath.delete(identity);
      continue;
    }
    entry.added = composed.added;
    entry.removed = composed.removed;
    if (composed.diff)
      sessionDiffs.push({
        path: entry.path,
        toolCallId: source.firstToolCallId,
        diff: composed.diff,
      });
  }
  for (const snapshot of snapshots.values()) {
    for (const file of snapshot.files) {
      const identity = resolveFilePath(snapshot.cwd, file.path);
      if (unresolvedPaths.has(identity)) continue;
      byPath.set(identity, {
        path: identity,
        added: file.added,
        removed: file.removed,
        count: Math.max(1, executionTouchCounts.get(identity)?.size ?? 0),
      });
      sessionDiffs.push({
        path: identity,
        toolCallId: `turn-diff:${snapshot.turnId}:${identity}`,
        diff: file.diff,
      });
    }
  }
  if (byPath.size === 0 && unresolvedPaths.size === 0) return null;
  return {
    files: Array.from(byPath.values()),
    sessionDiffs,
    ...(unresolvedPaths.size ? { unresolvedPaths: Array.from(unresolvedPaths) } : {}),
  };
}
