/**
 * Minimal unified-diff parser. Produces a structured AST for the
 * UnifiedDiffViewer to render. No support for renames-via-content
 * heuristics — we trust the `diff --git` header for file identity.
 *
 * The output models hunks as arrays of typed lines so the renderer
 * can class-tag without re-parsing per line.
 */

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "meta";
  text: string;
  /** Line numbers in old/new file, or null for meta/hunk-header lines. */
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string; // raw "@@ ... @@"
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** "added" | "deleted" | "modified" | "renamed" */
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      if (cur) files.push(cur);
      cur = {
        oldPath: null,
        newPath: null,
        status: "modified",
        hunks: [],
      };
      curHunk = null;
      continue;
    }

    if (!cur) continue;

    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      cur.oldPath = p === "/dev/null" ? null : stripPrefix(p);
      if (cur.oldPath === null) cur.status = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur.newPath = p === "/dev/null" ? null : stripPrefix(p);
      if (cur.newPath === null) cur.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      curHunk = {
        header: line,
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      oldLineNo = curHunk.oldStart;
      newLineNo = curHunk.newStart;
      cur.hunks.push(curHunk);
      continue;
    }

    if (!curHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      curHunk.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLineNo++,
      });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      curHunk.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldLineNo++,
        newLine: null,
      });
    } else if (line.startsWith(" ") || line === "") {
      // Context line (or blank line within hunk).
      curHunk.lines.push({
        kind: "ctx",
        text: line.slice(1),
        oldLine: oldLineNo++,
        newLine: newLineNo++,
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — meta marker.
      curHunk.lines.push({
        kind: "meta",
        text: line,
        oldLine: null,
        newLine: null,
      });
    }
  }

  if (cur) files.push(cur);
  return files;
}

/** Strip a/ or b/ prefix from git diff paths. */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
