/**
 * Which files a DriveAgent worker changed, for the "changed files" attribution
 * of its run.
 *
 * Two sources, merged:
 *
 *   - what the CLI reported in its own structured output (`changedFiles` on the
 *     run result — a Codex `file_change` item that completed, on either
 *     transport). Nothing has to be located or flushed for this one.
 *   - the CLI's transcript on disk (`readExternalChangedFiles`), which is the
 *     only source for Claude Code and a second one for Codex.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { readExternalChangedFiles } from "../cc-orchestrator/external-agent-changes.js";

function inside(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : undefined;
}

/** `path` with its symlinks resolved as far as it exists; the file itself may be gone. */
function resolved(path: string): string {
  const missing: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...missing);
    } catch {
      if (dirname(at) === at) return path;
      missing.unshift(basename(at));
    }
  }
}

/**
 * Canonicalize reported paths against the DriveAgent cwd. Claude and a current
 * Codex record absolute paths while an older Codex apply_patch records relative
 * ones; returning a cwd-relative display path for in-workspace files gives the
 * renderer one stable identity and removes duplicate hits. The cwd and a
 * reported path can spell the same place differently (a CLI reports the
 * resolved location of a cwd reached through a symlink, `/tmp` vs
 * `/private/tmp`), so a path outside the cwd as written is compared resolved.
 */
export function normalizeChangedFiles(cwd: string, files: readonly string[]): string[] {
  const realCwd = resolved(cwd);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || !file.trim()) continue;
    const reported = resolve(cwd, file.trim());
    const rel = inside(cwd, reported) ?? inside(realCwd, resolved(reported));
    const absolute = rel ? resolve(cwd, rel) : reported;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(rel ?? absolute);
  }
  return out;
}

/** The run's changed files, and how many raw reports they were reduced from. */
export function driveChangedFiles(
  cli: string,
  cwd: string,
  result: { sessionId: string; changedFiles?: readonly string[] },
  read: typeof readExternalChangedFiles,
): { rawSize: number; files: string[] } {
  const raw = [
    ...(result.changedFiles ?? []),
    ...(result.sessionId ? read(cli, cwd, result.sessionId) : []),
  ];
  return { rawSize: raw.length, files: normalizeChangedFiles(cwd, raw) };
}
