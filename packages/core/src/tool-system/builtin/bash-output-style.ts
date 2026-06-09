/**
 * Bash output styling classifier (A1 — Shell error highlighting).
 *
 * The Bash tool emits a single text body that interleaves three kinds of
 * content (see bash.ts):
 *   - the prepended status line `Exit code: N (command failed)` /
 *     `Killed by signal: X` (only present on failure),
 *   - stdout,
 *   - a stderr section introduced by a lone `STDERR:` marker line, which runs
 *     to the end of the body.
 *
 * Renderers (desktop ToolResultView, TUI ToolCall) want to tint the error
 * portions without mutating the text — copy must still yield the exact bytes
 * the model saw. This pure classifier maps each line to a kind so each surface
 * can apply its own error color. It deliberately lives next to bash.ts so the
 * markers it recognizes stay in lock-step with what bash.ts produces.
 *
 * NOTE: the desktop renderer cannot import core (thin-client rule), so it
 * duplicates this tiny logic. The TUI imports it directly. Keep the two in sync.
 */

export type BashLineKind = "normal" | "error";

export interface ClassifiedBashLine {
  /** The original line, verbatim (never trimmed/altered — copy fidelity). */
  text: string;
  kind: BashLineKind;
}

/** The exact status-line prefixes bash.ts prepends on a failed command. */
function isStatusLine(line: string): boolean {
  return /^Exit code: \d+ \(command failed\)$/.test(line) || /^Killed by signal: /.test(line);
}

/**
 * Classify each line of a Bash output body. Once the lone `STDERR:` marker is
 * seen, every subsequent line is part of the stderr region (sticky). Status
 * lines are flagged wherever they appear.
 */
export function classifyBashLines(lines: string[]): ClassifiedBashLine[] {
  let inStderr = false;
  return lines.map((text) => {
    if (text === "STDERR:") {
      inStderr = true;
      return { text, kind: "error" };
    }
    const kind: BashLineKind = inStderr || isStatusLine(text) ? "error" : "normal";
    return { text, kind };
  });
}
