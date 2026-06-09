import type { ToolMessage } from "../types";

export function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Last path segment of a file path — `docs/a/b.svg` → `b.svg`. Handles both
 * `/` and `\` separators and trailing slashes; falls back to the input if it
 * has no separator. Used to show a readable filename instead of a full
 * (often long / temp-dir) path while the title attr keeps the full path.
 */
export function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const seg = trimmed.split(/[/\\]/).pop();
  return seg && seg.length > 0 ? seg : p;
}

/** Parsed args object, preferring argsLive if present (live streaming). */
export function parsedArgs(m: ToolMessage): Record<string, unknown> {
  if (m.argsLive) return m.argsLive;
  try {
    const obj = JSON.parse(m.args);
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Per-line error classification for Bash output (A1 highlighting). Duplicated
 * from core's `classifyBashLines` because the renderer is a thin client and
 * cannot import @cjhyy/code-shell-core — keep the two in sync. The `STDERR:`
 * marker starts a sticky stderr region; `Exit code: N (command failed)` and
 * `Killed by signal: X` status lines are flagged wherever they appear. Text is
 * returned verbatim so copy still yields the exact bytes the model saw.
 */
export function classifyBashLines(lines: string[]): { text: string; isError: boolean }[] {
  let inStderr = false;
  return lines.map((text) => {
    if (text === "STDERR:") {
      inStderr = true;
      return { text, isError: true };
    }
    const isStatus =
      /^Exit code: \d+ \(command failed\)$/.test(text) || /^Killed by signal: /.test(text);
    return { text, isError: inStderr || isStatus };
  });
}

export function formatDuration(ms?: number): string | null {
  if (typeof ms !== "number" || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
