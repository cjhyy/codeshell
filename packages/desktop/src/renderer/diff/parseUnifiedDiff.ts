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
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      cur = {
        oldPath: paths?.[0] ?? null,
        newPath: paths?.[1] ?? null,
        status: "modified",
        hunks: [],
      };
      curHunk = null;
      continue;
    }

    if (!cur) continue;

    if (!curHunk && line.startsWith("--- ")) {
      const p = gitPath(line.slice(4));
      cur.oldPath = p === "/dev/null" ? null : stripPrefix(p);
      if (cur.oldPath === null) cur.status = "added";
      continue;
    }
    if (!curHunk && line.startsWith("+++ ")) {
      const p = gitPath(line.slice(4));
      cur.newPath = p === "/dev/null" ? null : stripPrefix(p);
      if (cur.newPath === null) cur.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = gitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.newPath = gitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.status = "added";
      cur.oldPath = null;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
      cur.newPath = null;
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

    if (line.startsWith("+")) {
      curHunk.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLineNo++,
      });
    } else if (line.startsWith("-")) {
      curHunk.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldLineNo++,
        newLine: null,
      });
    } else if (line.startsWith(" ")) {
      // Even an empty context line has a space prefix. The final split empty
      // string is not part of the hunk and must not advance either line number.
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

/** Git quotes path bytes with C escapes; octal escapes encode UTF-8 bytes. */
function gitPath(raw: string): string {
  // Unquoted ---/+++ paths may carry a tab-delimited timestamp. Never trim
  // actual leading/trailing filename spaces or split a decoded literal tab.
  if (!raw.startsWith('"')) return raw.split("\t", 1)[0];
  return quotedGitPath(raw)?.path ?? raw;
}

/** A quoted header token must expose its exact closing boundary as well as
 * its decoded bytes; otherwise a second path or trailing junk gets consumed. */
function quotedGitPath(raw: string): { path: string; end: number } | null {
  if (!raw.startsWith('"')) return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let index = 1; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"')
      return { path: new TextDecoder().decode(new Uint8Array(bytes)), end: index + 1 };
    if (char === "\\") {
      const octal = /^[0-7]{1,3}/.exec(raw.slice(index + 1));
      if (octal) {
        bytes.push(parseInt(octal[0], 8));
        index += octal[0].length;
        continue;
      }
      const escaped = escapes[raw[index + 1]];
      if (escaped !== undefined) {
        bytes.push(escaped);
        index++;
        continue;
      }
    }
    const point = String.fromCodePoint(raw.codePointAt(index)!);
    bytes.push(...encoder.encode(point));
    index += point.length - 1;
  }
  return null; // An incomplete quoted header has no trustworthy decoded path.
}

/** Header identity is a fallback: content and rename headers remain authoritative.
 * Unquoted spaces can only describe the same old/new path unambiguously.
 * Equal sides determine one split by length, even if the filename contains b/.
 * Avoid guessing different space-containing paths or retrying every separator. */
function gitHeaderPaths(raw: string): [string, string] | null {
  let oldPath: string;
  let newPath: string;
  const unquoted = (path: string) => path.length > 0 && !/["\\\x00-\x1f\x7f]/.test(path);
  if (raw.startsWith('"')) {
    const old = quotedGitPath(raw);
    if (!old || raw[old.end] !== " ") return null;
    oldPath = old.path;
    const remainder = raw.slice(old.end + 1);
    if (remainder.startsWith('"')) {
      const next = quotedGitPath(remainder);
      if (!next || next.end !== remainder.length) return null;
      newPath = next.path;
    } else {
      if (!unquoted(remainder)) return null;
      newPath = remainder;
      if (newPath.includes(" ") && oldPath.slice(2) !== newPath.slice(2)) return null;
    }
  } else {
    const at = raw.indexOf(" ");
    if (at < 0) return null;
    const remainder = raw.slice(at + 1);
    if (remainder.startsWith('"')) {
      oldPath = raw.slice(0, at);
      const next = quotedGitPath(remainder);
      if (!unquoted(oldPath) || !next || next.end !== remainder.length) return null;
      newPath = next.path;
    } else {
      if (!unquoted(raw)) return null;
      const length = (raw.length - 5) / 2;
      const split = 2 + length;
      if (
        Number.isInteger(length) &&
        raw.slice(split, split + 3) === " b/" &&
        raw.slice(2, split) === raw.slice(split + 3)
      ) {
        oldPath = raw.slice(0, split);
        newPath = raw.slice(split + 1);
      } else {
        if (remainder.includes(" ")) return null;
        oldPath = raw.slice(0, at);
        newPath = remainder;
      }
    }
  }
  if (
    !oldPath.startsWith("a/") ||
    !newPath.startsWith("b/") ||
    oldPath.length <= 2 ||
    newPath.length <= 2
  )
    return null;
  return [oldPath.slice(2), newPath.slice(2)];
}

/** Strip a/ or b/ prefix from git diff paths. */
function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
