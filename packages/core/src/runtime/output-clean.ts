/**
 * output-clean — sanitize raw process output before it's handed to the LLM.
 *
 * Background dev servers (`npm run dev`, vite, webpack) emit two kinds of
 * noise that are worthless — and token-expensive — in a model's context
 * (design §难点4):
 *
 *   - ANSI escape sequences (colors, cursor moves, line erases).
 *   - `\r`-driven progress redraws (`▕███░ 45%\r▕████ 100%`) where every
 *     frame but the last is stale.
 *
 * The *raw* bytes are still persisted to disk untouched (so a user `tail`ing
 * the file keeps colors); this cleanup only applies to what `BashOutput`
 * returns to the agent.
 */

// Matches CSI sequences (ESC [ ... final-byte) plus a few common non-CSI
// escapes (ESC ] OSC, single-char escapes). Good enough for dev-server output;
// we deliberately don't pull in a full terminal parser.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "");
}

/**
 * Collapse carriage-return progress redraws. Within a single line (text
 * between `\n`s), `\r` means "redraw from column 0" — only the segment after
 * the last `\r` survives. Newlines are preserved as line separators.
 */
export function foldProgressLines(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr === -1 ? line : line.slice(lastCr + 1);
    })
    .join("\n");
}

/** Strip ANSI then fold progress frames — the full agent-facing cleanup. */
export function cleanOutput(s: string): string {
  return foldProgressLines(stripAnsi(s));
}
