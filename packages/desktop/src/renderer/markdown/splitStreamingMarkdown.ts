/**
 * Split a streaming markdown buffer into a STABLE PREFIX (safe to render through
 * a markdown pipeline) and an ACTIVE TAIL (rendered as plain text). The goal:
 * render closed blocks as rich markdown while a message streams, and show the
 * still-arriving trailing content as source — without the half-parsed jitter
 * that made the old code render everything as `<pre>` until `done`.
 *
 * Design invariants (from the plan's review corrections):
 *  - **Split on a blank-line (`\n\n`) boundary, never mid-block** (C3). Markdown
 *    block boundaries depend on the FOLLOWING line: a paragraph line becomes a
 *    setext heading if the next line is `===`/`---`; paragraphs lazily continue
 *    across non-blank lines; list looseness depends on blank lines. So only
 *    content before the last blank line is safe from retroactive reparse.
 *  - **Never split inside an open fenced code block** (C1). Fence detection is
 *    CommonMark-correct: line-anchored, ``` or ~~~, length-aware (a fence closes
 *    only with ≥ as many of the same char), inline backticks ignored. If a fence
 *    is open at the chosen boundary, pull the split back to before that fence.
 *  - **When unsure, push into activeTail.** Conservative: a too-small stable
 *    prefix only means slightly less live rich rendering, never jitter or a
 *    half-parsed block reaching the pipeline.
 *
 * Known limitation (C2): reference-style links / footnotes whose definition
 * (`[x]: url`) is still in the tail render as literal text in the prefix until
 * `done`. Splitting on blank lines keeps the most-recent paragraph in the tail,
 * which covers the common case but not a definition many lines below its use.
 */

export interface StreamingSplit {
  stablePrefix: string;
  activeTail: string;
}

/** A fenced-code-block opener: optional ≤3 spaces indent, then ``` or ~~~ run. */
interface OpenFence {
  /** Index into the lines array where this fence opened. */
  line: number;
  char: "`" | "~";
  len: number;
}

/** Match a fence marker at line start (≤3 spaces indent). Returns null if none. */
function fenceAt(line: string): { char: "`" | "~"; len: number; info: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const run = m[1];
  const info = m[2];
  // A closing ``` fence must not contain backticks in its info string; an
  // opening one may carry a language. We don't need that distinction for
  // open/close *pairing* (handled by the state machine), but a ``` fence
  // whose info contains a backtick can never be a valid info string, so it's
  // treated as text — matches CommonMark and avoids inline-code false hits.
  if (run[0] === "`" && info.includes("`")) return null;
  return { char: run[0] as "`" | "~", len: run.length, info };
}

/**
 * Walk the lines tracking fenced-code state. Returns, for each line index,
 * whether a fence is OPEN *after* that line, plus the index of the currently
 * open fence's opener (or -1). This lets the splitter avoid cutting inside an
 * open block and know where the last open fence began.
 */
function scanFences(lines: string[]): { openAfter: boolean[]; openFenceStart: number } {
  const openAfter: boolean[] = new Array(lines.length).fill(false);
  let open: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = fenceAt(lines[i]);
    if (open === null) {
      // Not in a fence: an opener starts one.
      if (f) open = { line: i, char: f.char, len: f.len };
    } else {
      // Inside a fence: a closer is the SAME char, length ≥ opener, empty info.
      if (f && f.char === open.char && f.len >= open.len && f.info.trim() === "") {
        open = null;
      }
    }
    openAfter[i] = open !== null;
  }
  return { openAfter, openFenceStart: open ? open.line : -1 };
}

export function splitStreamingMarkdown(text: string): StreamingSplit {
  if (text === "") return { stablePrefix: "", activeTail: "" };

  const lines = text.split("\n");
  const { openAfter, openFenceStart } = scanFences(lines);

  // If a fence is still open at the very end, everything from that fence's
  // opener onward is unstable — the block isn't closed yet (C1).
  const fenceFloor = openFenceStart === -1 ? lines.length : openFenceStart;

  // Find the last blank-line boundary at or before fenceFloor whose position
  // is NOT inside an open fence. A "blank line" is an empty/whitespace-only
  // line that separates blocks; the stable prefix ends just before it, and the
  // blank line + everything after is the active tail (C3).
  //
  // We scan from just below the floor upward for a blank line, then require the
  // line right before it to not be inside an open fence.
  let boundary = -1; // line index of the blank line that ends the prefix
  for (let i = Math.min(fenceFloor, lines.length) - 1; i >= 0; i--) {
    if (lines[i].trim() === "" && !openAfter[i]) {
      boundary = i;
      break;
    }
  }

  if (boundary === -1) {
    // No safe blank-line boundary → nothing is stable yet; render it all as
    // the active tail (this is today's behaviour for short/single-block text).
    return { stablePrefix: "", activeTail: text };
  }

  // stablePrefix = lines [0, boundary) joined; the blank line at `boundary`
  // and everything after → activeTail. Trim trailing blank lines off the
  // prefix so it re-parses cleanly and doesn't drag the separator along.
  const prefixLines = lines.slice(0, boundary);
  while (prefixLines.length > 0 && prefixLines[prefixLines.length - 1].trim() === "") {
    prefixLines.pop();
  }
  if (prefixLines.length === 0) return { stablePrefix: "", activeTail: text };

  const stablePrefix = prefixLines.join("\n");
  const activeTail = lines.slice(boundary).join("\n");
  return { stablePrefix, activeTail };
}
