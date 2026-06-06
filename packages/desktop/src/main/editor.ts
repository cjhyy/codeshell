/**
 * Resolve which external editor to open a file in, and how to invoke it.
 *
 * Kept pure (no spawn / fs) so the command-building logic is unit-testable;
 * desktop-services wires the result to execFile. The editor is chosen from
 * `CODE_SHELL_EDITOR` when set, else a default chain (Cursor → VS Code). We
 * keep the line suffix (`file:line:col`) and translate it to the editor's
 * `--goto` flag so "open in editor" lands on the right line — unlike the OS
 * "open" which can't honor a line number.
 */

export interface EditorInvocation {
  command: string;
  args: string[];
}

/** Editors that take `--goto path:line:col` (VS Code family, incl. Cursor). */
const GOTO_EDITORS = new Set(["code", "cursor", "code-insiders", "codium", "vscodium"]);

/**
 * Build the command + args to open `target` (optionally `path:line:col`) in an
 * editor. `editorEnv` is the raw `CODE_SHELL_EDITOR` value (may be empty); when
 * empty we fall back to the first default. The caller is responsible for
 * checking the command actually exists on PATH and trying the next candidate.
 *
 * Returns the candidate list in priority order so the caller can try each until
 * one launches.
 */
export function editorCandidates(editorEnv: string | undefined): string[] {
  const fromEnv = (editorEnv ?? "").trim();
  if (fromEnv) return [fromEnv];
  return ["cursor", "code"];
}

/** Split a "path:line:col" / "path:line" target into path + optional line/col. */
export function splitTarget(target: string): {
  path: string;
  line?: number;
  col?: number;
} {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(target);
  if (!m) return { path: target };
  return {
    path: m[1],
    line: Number(m[2]),
    col: m[3] ? Number(m[3]) : undefined,
  };
}

/**
 * Given a resolved editor command and an absolute target (possibly with a line
 * suffix), produce the invocation. VS Code-family editors get `--goto` so the
 * line is honored; anything else just receives the bare path.
 */
export function buildEditorInvocation(
  command: string,
  absPath: string,
  line?: number,
  col?: number,
): EditorInvocation {
  const base = command.split(/\s+/)[0] ?? command;
  if (GOTO_EDITORS.has(base) && line) {
    const goto = col ? `${absPath}:${line}:${col}` : `${absPath}:${line}`;
    return { command, args: ["--goto", goto] };
  }
  return { command, args: [absPath] };
}
