import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import { checkedExternalUrl } from "../app-renderer-navigation.js";
import { editorCandidates, splitTarget, buildEditorInvocation } from "../editor.js";
import { resolveTargetPath } from "../paths.js";

const execFileAsync = promisify(execFile);

export async function openExternal(url: string): Promise<void> {
  // Local files use the separately authorized open/reveal file IPCs.
  await shell.openExternal(checkedExternalUrl(url));
}

/**
 * Reveal a file in Finder / Explorer WITHOUT opening it. Accepts a relative
 * path + `cwd` and a `:line` suffix (resolved/stripped here) so the renderer's
 * "在文件夹中显示" action no longer has to round-trip through `openPath` — which
 * would launch the file in its default app as a side effect (#bug).
 */
export async function revealInFinder(targetPath: string, cwd?: string): Promise<void> {
  const absolute = resolveTargetPath(targetPath, cwd);
  // showItemInFolder silently does nothing for a missing path (no window, no
  // error), leaving the user with no feedback. Check first and throw so the
  // renderer can surface a toast (e.g. file was deleted/renamed since the
  // message referenced it).
  try {
    await fs.access(absolute);
  } catch {
    throw new Error(`文件不存在:${absolute}`);
  }
  shell.showItemInFolder(absolute);
}

/**
 * Open a file with the system default application. Supports the
 * "<path>:<line>" form emitted by tools and assistant text — the line
 * suffix is discarded (shell.openPath has no concept of line
 * numbers); users who need it should bind a richer editor protocol
 * themselves.
 *
 * Resolves relative paths against the supplied cwd so click-through
 * works for the assistant's own bash output (which is usually
 * relative). Returns the resolved absolute path on success.
 *
 * If the file doesn't exist on disk we fall through to revealing the
 * containing directory in Finder, which is what people usually want
 * when a generated file moved or was renamed.
 */
export async function openPath(targetPath: string, cwd?: string): Promise<string> {
  const absolute = resolveTargetPath(targetPath, cwd);
  try {
    await fs.access(absolute);
  } catch {
    // Best-effort: show the parent directory so the user can find it.
    shell.showItemInFolder(path.dirname(absolute));
    return absolute;
  }
  const err = await shell.openPath(absolute);
  if (err) throw new Error(`openPath failed: ${err}`);
  return absolute;
}

/**
 * Open a file in an external editor (Cursor / VS Code by default, overridable
 * via `CODE_SHELL_EDITOR`). Honors a trailing `:line[:col]` suffix via the
 * editor's `--goto` flag. Tries each candidate in priority order and returns
 * the command that launched; throws if none are on PATH so the renderer can
 * fall back to the OS "open".
 */
export async function openInEditor(targetPath: string, cwd?: string): Promise<string> {
  const { path: rel, line, col } = splitTarget(targetPath);
  const absolute = path.isAbsolute(rel) ? rel : path.resolve(cwd ?? process.cwd(), rel);
  const candidates = editorCandidates(process.env.CODE_SHELL_EDITOR);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    const { command, args } = buildEditorInvocation(candidate, absolute, line, col);
    try {
      // detached so closing the app doesn't take the editor down; the editor
      // CLIs return immediately anyway.
      await execFileAsync(command, args);
      return command;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `no editor found (tried ${candidates.join(", ")})` +
      (lastErr ? `: ${String(lastErr instanceof Error ? lastErr.message : lastErr)}` : ""),
  );
}
