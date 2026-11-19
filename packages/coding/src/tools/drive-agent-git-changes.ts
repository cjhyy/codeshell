/**
 * What a DriveAgent worker changed in its git work tree, read from git itself.
 *
 * The CLI's own records (`drive-agent-changed-files.ts`) name the files of a
 * patch or an edit tool. A file written by a shell command (`sed -i`, a code
 * generator, a formatter, `git mv`) appears in none of them. Git sees all of
 * it: the work tree is compared with a baseline taken before the run.
 *
 * Only valid when the worker owns the directory for the run, which is
 * DriveAgent's `isolation: "worktree"`. In a shared directory another writer's
 * files would be attributed to this worker, so no baseline is taken there.
 *
 * Ignored files stay out (git does not report them). Everything here is best
 * effort: without git, outside a repository, or on any git failure the result
 * is `undefined` and the run is attributed from the CLI's records alone.
 */
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { GIT_BIN } from "../git/worktree/git-exec.js";

/** Most files attributed from git for one run; the rest are counted, not listed. */
export const DRIVE_GIT_CHANGED_FILES_CAP = 100;

/** Quiet (git's complaints stay off the host's stderr) and roomy enough for a large listing. */
function execGitSync(cwd: string, args: string[]): string {
  return execFileSync(GIT_BIN, args, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export interface DriveGitBaseline {
  /** Top level of the work tree; git reports paths relative to it. */
  root: string;
  /** Commit checked out before the run. Absent on a branch with no commit. */
  head?: string;
  /** Root-relative path → state, for every path git reported as not clean. */
  dirty: Map<string, string>;
}

function headOf(root: string): string | undefined {
  try {
    return execGitSync(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Status code plus size and modification time: enough to tell that a file
 * which was already modified or untracked before the run was written again.
 */
function stateOf(root: string, path: string, code: string): string {
  try {
    const stat = lstatSync(resolve(root, path));
    return `${code}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${code}:gone`;
  }
}

/** Every path `git status` reports, both sides of a rename included. */
function dirtyPaths(root: string): Map<string, string> {
  const out = execGitSync(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = new Map<string, string>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    dirty.set(field.slice(3), stateOf(root, field.slice(3), code));
    // `XY new\0old\0`: a rename or copy carries its source as the next field.
    if (code.includes("R") || code.includes("C")) {
      i += 1;
      const source = fields[i];
      if (source) dirty.set(source, stateOf(root, source, code));
    }
  }
  return dirty;
}

/** The state of `cwd`'s work tree now, or undefined when git cannot tell. */
export function snapshotDriveGitState(cwd: string): DriveGitBaseline | undefined {
  try {
    const root = execGitSync(cwd, ["rev-parse", "--show-toplevel"]).trim();
    if (!root) return undefined;
    const head = headOf(root);
    return { root, ...(head ? { head } : {}), dirty: dirtyPaths(root) };
  } catch {
    return undefined;
  }
}

/**
 * Absolute paths that differ from `baseline`, at most
 * `DRIVE_GIT_CHANGED_FILES_CAP` of them, and how many there were in all:
 * paths whose status or content changed, paths that became clean again, and
 * the files of commits made since.
 */
export function driveGitChangedFiles(
  baseline: DriveGitBaseline | undefined,
): { files: string[]; total: number } | undefined {
  if (!baseline) return undefined;
  try {
    const { root } = baseline;
    const now = dirtyPaths(root);
    const changed = new Set<string>();
    for (const [path, state] of now) if (baseline.dirty.get(path) !== state) changed.add(path);
    for (const path of baseline.dirty.keys()) if (!now.has(path)) changed.add(path);
    const head = headOf(root);
    if (baseline.head && head && head !== baseline.head) {
      const committed = execGitSync(root, ["diff", "--name-only", "-z", baseline.head, head]);
      for (const path of committed.split("\0")) if (path) changed.add(path);
    }
    return {
      files: [...changed].slice(0, DRIVE_GIT_CHANGED_FILES_CAP).map((path) => resolve(root, path)),
      total: changed.size,
    };
  } catch {
    return undefined;
  }
}
