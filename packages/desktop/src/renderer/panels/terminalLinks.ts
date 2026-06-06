/**
 * Pure link detection for terminal output lines.
 *
 * xterm.js exposes a per-line `registerLinkProvider` API: given the text of a
 * single buffer row, return the ranges that should be underlined/clickable.
 * This module owns the matching so it can be unit-tested without xterm or a
 * DOM. TerminalPanel adapts the matches to xterm's 1-based column ranges and
 * routes activation (openExternal for URLs, openPath for files).
 *
 * Two link kinds:
 *   - "url":  http / https — opened in the OS browser.
 *   - "path": a workspace-relative or absolute file path with an extension,
 *             optionally suffixed with :line[:col]. Opened in the editor.
 *
 * The matchers are deliberately conservative — terminal output is noisy, and a
 * false underline on every word is worse than missing one. A path must contain
 * a separator AND an extension, or be absolute; bare words never match.
 */

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  /** 0-based index into the line where the match starts. */
  start: number;
  /** Length of the matched text in characters. */
  length: number;
  kind: TerminalLinkKind;
  /** The raw matched text (URL, or `path[:line[:col]]`). */
  text: string;
}

// URLs: http(s) only — we don't want to make file:// or mailto: clickable in a
// shell. Stops at whitespace and common trailing punctuation/brackets so a URL
// at the end of a sentence ("see https://x.com.") doesn't swallow the period or
// a wrapping paren.
const URL_RE = /https?:\/\/[^\s)>\]}"'`]+/g;

// Strip trailing punctuation that's almost certainly prose, not part of the URL.
const URL_TRAILING = /[.,;:!?)\]}>'"`]+$/;

// File paths: same conservative shape as the markdown remarkPathLinks matcher,
// minus the prose-boundary lookbehind (terminal cells are already tokenised by
// whitespace when we split). A path is either absolute (/…), dot-relative
// (./… or ../…), or a bare seg/more form, and must end in a short extension.
// An optional :line[:col] suffix is captured so the editor can jump.
const PATH_RE =
  /(?:\/|\.{1,2}\/|[\w@.-]+\/)[\w./@+\-]+\.[\w]{1,8}(?::\d+(?::\d+)?)?/g;

/**
 * Find all clickable ranges in a single terminal line. URLs take precedence:
 * a path-looking substring inside a URL (e.g. the `/a/b.js` in a URL path) must
 * not be matched a second time as a file. Overlapping path matches are dropped.
 */
export function findTerminalLinks(line: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line))) {
    let text = m[0];
    let length = text.length;
    const trimmed = text.replace(URL_TRAILING, "");
    if (trimmed.length > 0 && trimmed.length < text.length) {
      length = trimmed.length;
      text = trimmed;
    }
    matches.push({ start: m.index, length, kind: "url", text });
  }

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(line))) {
    const start = m.index;
    const end = start + m[0].length;
    // Skip a path that overlaps an already-claimed URL range.
    const overlapsUrl = matches.some(
      (u) => u.kind === "url" && start < u.start + u.length && end > u.start,
    );
    if (overlapsUrl) continue;
    matches.push({ start, length: m[0].length, kind: "path", text: m[0] });
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

/** Split a path match's text into its path and optional line number. */
export function splitPathAndLine(text: string): { path: string; line?: number } {
  const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(text);
  if (!m) return { path: text };
  const path = m[1] ?? text;
  const line = m[2] ? Number(m[2]) : undefined;
  return line !== undefined ? { path, line } : { path };
}
