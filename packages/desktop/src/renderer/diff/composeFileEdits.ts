export interface FileSnippetEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type FileEditOperation =
  | ({ kind: "edit" } & FileSnippetEdit)
  | { kind: "write"; content: string }
  | { kind: "opaque"; diff: string };

interface Snippet {
  kind: "snippet";
  oldText: string;
  newText: string;
  /** A Write supplied the whole after-content, so it cannot gain outer context. */
  fullContent: boolean;
}

interface OpaquePatch {
  kind: "opaque";
  body: string;
  metadata: string[];
  added: boolean;
  deleted: boolean;
}

function linesOf(text: string): string[] {
  if (!text) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function hunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/** A snippet preview: its line numbers describe the supplied text, not the file. */
export function syntheticSnippetDiff(
  file: string,
  oldText: string,
  newText: string,
  status: "modified" | "added" = "modified",
  hunkIndex?: number,
): string {
  if (oldText === newText && status !== "added") return "";
  const oldLinesAll = linesOf(oldText);
  const newLinesAll = linesOf(newText);
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
    `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@${
      hunkIndex ? ` edit ${hunkIndex}` : ""
    }`,
    ...ctxBefore.map((line) => ` ${line}`),
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    ...ctxAfter.map((line) => ` ${line}`),
    "",
  ].join("\n");
}

function opaquePatch(diff: string): OpaquePatch {
  const body: string[] = [];
  const metadata: string[] = [];
  let inHunk = false;
  let added = false;
  let deleted = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
      body.push(line);
    } else if (inHunk) {
      body.push(line);
    } else if (line.startsWith("--- ")) {
      added ||= line.slice(4) === "/dev/null";
    } else if (line.startsWith("+++ ")) {
      deleted ||= line.slice(4) === "/dev/null";
    } else if (line.startsWith("new file mode ")) {
      added = true;
    } else if (line.startsWith("deleted file mode ")) {
      deleted = true;
    } else if (line && !line.startsWith("index ")) {
      metadata.push(line);
    }
  }
  return { kind: "opaque", body: body.join("\n").replace(/\n+$/, ""), metadata, added, deleted };
}

function uniqueIndex(text: string, search: string): number {
  if (!search) return -1;
  const index = text.indexOf(search);
  return index >= 0 && text.indexOf(search, index + 1) < 0 ? index : -1;
}

function replay(snippet: Snippet, edit: FileSnippetEdit): boolean {
  const index = uniqueIndex(snippet.newText, edit.oldText);
  if (index >= 0) {
    snippet.newText =
      snippet.newText.slice(0, index) +
      edit.newText +
      snippet.newText.slice(index + edit.oldText.length);
    return true;
  }
  // A later edit can supply more surrounding text. Reconstruct its before-side
  // only when the whole known after-fragment occurs exactly once in that text.
  const outerIndex = snippet.fullContent ? -1 : uniqueIndex(edit.oldText, snippet.newText);
  if (outerIndex < 0) return false;
  snippet.oldText =
    edit.oldText.slice(0, outerIndex) +
    snippet.oldText +
    edit.oldText.slice(outerIndex + snippet.newText.length);
  snippet.newText = edit.newText;
  return true;
}

/**
 * Compose proven adjacent snippet edits, retaining unresolved operations as
 * separate hunks under one file header. This is a tool-payload preview, not a
 * reconstruction of the complete file or its real line positions.
 */
export function composeFileEdits(
  path: string,
  operations: readonly FileEditOperation[],
): { diff: string; added: number; removed: number } {
  const segments: (Snippet | OpaquePatch)[] = [];
  let active: Snippet | null = null;
  let initiallyAbsent: boolean | undefined;
  let finallyAbsent = false;
  let explicitMetadata = false;

  for (const operation of operations) {
    if (operation.kind === "opaque" || (operation.kind === "edit" && operation.replaceAll)) {
      const patch = opaquePatch(
        operation.kind === "opaque"
          ? operation.diff
          : syntheticSnippetDiff(path, operation.oldText, operation.newText),
      );
      if (patch.body || patch.metadata.length || patch.added || patch.deleted) {
        initiallyAbsent ??= patch.added;
        finallyAbsent = patch.deleted;
        explicitMetadata ||= patch.added || patch.deleted || patch.metadata.length > 0;
        segments.push(patch);
      }
      active = null;
      continue;
    }
    if (operation.kind === "write") {
      initiallyAbsent ??= true;
      finallyAbsent = false;
      explicitMetadata = true;
      if (active?.fullContent) {
        active.newText = operation.content;
      } else {
        active = { kind: "snippet", oldText: "", newText: operation.content, fullContent: true };
        segments.push(active);
      }
      continue;
    }
    initiallyAbsent ??= false;
    finallyAbsent = false;
    if (active && replay(active, operation)) continue;
    active = {
      kind: "snippet",
      oldText: operation.oldText,
      newText: operation.newText,
      fullContent: false,
    };
    segments.push(active);
  }

  const patches = segments.map((segment, index) =>
    segment.kind === "opaque"
      ? segment
      : opaquePatch(
          syntheticSnippetDiff(
            path,
            segment.oldText,
            segment.newText,
            segment.fullContent ? "added" : "modified",
            segments.length > 1 ? index + 1 : undefined,
          ),
        ),
  );
  const bodies = patches.map((patch) => patch.body).filter(Boolean);
  const metadata = [...new Set(patches.flatMap((patch) => patch.metadata))];
  if (bodies.length === 0 && !explicitMetadata) return { diff: "", added: 0, removed: 0 };
  const status = finallyAbsent ? "deleted" : initiallyAbsent ? "added" : "modified";
  let added = 0;
  let removed = 0;
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return {
    diff: [
      `diff --git a/${path} b/${path}`,
      ...(status === "added" ? ["new file mode 100644"] : []),
      ...(status === "deleted" ? ["deleted file mode 100644"] : []),
      ...metadata,
      status === "added" ? "--- /dev/null" : `--- a/${path}`,
      status === "deleted" ? "+++ /dev/null" : `+++ b/${path}`,
      ...bodies,
      "",
    ].join("\n"),
    added,
    removed,
  };
}
