/**
 * Desktop-side services that don't belong in the agent worker:
 *   - git status / git diff (renderer needs these to render Diff inspector)
 *   - openExternal, revealInFinder (Electron-only file actions)
 *
 * Each function spawns a child process synchronously-ish (via execFile
 * promise) and returns plain data. Errors are normalized to throw a
 * single Error subclass so the renderer can route them uniformly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface GitStatusEntry {
  /** XY status code per git porcelain v1 (e.g. " M", "??", "A ", "MM"). */
  code: string;
  path: string;
}

export interface GitStatus {
  branch: string | null;
  entries: GitStatusEntry[];
  clean: boolean;
}

export interface GitBranches {
  isRepo: boolean;
  current: string | null;
  branches: string[];
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  current: boolean;
}

export interface CreatedWorktree {
  path: string;
  name: string;
  branch: string;
  originalBranch: string | null;
}

async function gitRun(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024, // 32 MB cap; diffs can be huge
    windowsHide: true,
  });
  return stdout;
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  let branch: string | null = null;
  try {
    branch = (await gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    branch = null;
  }
  let raw = "";
  try {
    raw = await gitRun(cwd, ["status", "--porcelain=v1"]);
  } catch {
    return { branch, entries: [], clean: true };
  }
  const entries: GitStatusEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).trim();
    entries.push({ code, path: p });
  }
  return { branch, entries, clean: entries.length === 0 };
}

export async function getGitBranches(cwd: string): Promise<GitBranches> {
  // Distinguish "not a repo" from "fresh repo with no commits". The
  // abbrev-ref query fails on the latter too, so check is-inside-work-tree
  // first — that way a freshly init'd repo doesn't falsely report
  // isRepo: false.
  try {
    const inside = (await gitRun(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return { isRepo: false, current: null, branches: [] };
  } catch {
    return { isRepo: false, current: null, branches: [] };
  }

  let current: string | null = null;
  try {
    current = (await gitRun(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    // No commits yet — keep isRepo: true with null current.
    current = null;
  }

  let raw = "";
  try {
    raw = await gitRun(cwd, ["branch", "--format=%(refname:short)"]);
  } catch {
    raw = "";
  }
  const branches = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return { isRepo: true, current, branches };
}

export async function switchGitBranch(cwd: string, branch: string): Promise<GitBranches> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch is required");

  const before = await getGitBranches(cwd);
  if (!before.isRepo) throw new Error("Not a Git repository");
  if (!before.branches.includes(trimmed)) throw new Error(`Local branch not found: ${trimmed}`);

  await gitRun(cwd, ["switch", trimmed]);
  return getGitBranches(cwd);
}

export async function stashAndSwitchGitBranch(cwd: string, branch: string): Promise<GitBranches> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch is required");

  const before = await getGitBranches(cwd);
  if (!before.isRepo) throw new Error("Not a Git repository");
  if (!before.branches.includes(trimmed)) throw new Error(`Local branch not found: ${trimmed}`);

  await gitRun(cwd, ["stash", "push", "-u", "-m", `CodeShell auto-stash before switching to ${trimmed}`]);
  await gitRun(cwd, ["switch", trimmed]);
  return getGitBranches(cwd);
}

export async function createPermanentWorktree(
  cwd: string,
  requestedName: string,
  branchPrefix?: string,
): Promise<CreatedWorktree> {
  const root = (await gitRun(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const name = normalizeWorktreeName(requestedName);
  const suffix = Date.now().toString(36);
  const prefix = normalizeBranchPrefixMain(branchPrefix);
  const branch = `${prefix}${name}-${suffix}`;
  const worktreePath = path.resolve(root, "..", ".worktrees", `${name}-${suffix}`);

  let originalBranch: string | null = null;
  try {
    originalBranch = (await gitRun(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    originalBranch = null;
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await gitRun(root, ["worktree", "add", "-b", branch, worktreePath]);
  // No node_modules / .venv / .pnpm-store symlinks: in a bun or pnpm
  // workspace monorepo, root node_modules holds RELATIVE symlinks like
  // `@scope/pkg -> ../../packages/pkg`. Symlinking the whole tree into
  // ../.worktrees/foo would make those workspace links resolve to the
  // SOURCE repo's packages/*, not the worktree's — silent
  // edits-don't-take-effect bugs. Users should `bun install` in the
  // worktree themselves; correct over fast.
  return { path: worktreePath, name, branch, originalBranch };
}

export async function listGitWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  let root = cwd;
  try {
    root = (await gitRun(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return [];
  }

  const raw = await gitRun(root, ["worktree", "list", "--porcelain"]);
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      const p = line.slice("worktree ".length);
      cur = { path: p, branch: null, head: null, current: path.resolve(p) === path.resolve(root) };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length, "HEAD ".length + 8);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Normalize a branch prefix. Allowed chars: [A-Za-z0-9._/-]. Always
 * ends in "/". Falls back to "codeshell/" when input is empty/invalid.
 * Duplicates renderer/gitPrefs.ts's normalizeBranchPrefix; kept here so
 * main never imports from the renderer bundle.
 */
function normalizeBranchPrefixMain(input: string | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return "codeshell/";
  const cleaned = raw.replace(/[^a-zA-Z0-9._/-]/g, "");
  if (!cleaned) return "codeshell/";
  return cleaned.endsWith("/") ? cleaned : cleaned + "/";
}

/**
 * Remove all worktrees under <repo>/../.worktrees/ whose directory
 * mtime is older than `graceMinutes`. Removes both the worktree and
 * its `<prefix>...` local branch (best-effort).
 *
 * Returns the list of removed paths so the caller can log them.
 * Errors on individual worktrees are swallowed — we always try the
 * rest. The caller decides scheduling (startup + periodic timer).
 */
export async function cleanupStaleWorktrees(
  repoRoot: string,
  graceMinutes: number,
): Promise<string[]> {
  if (!Number.isFinite(graceMinutes) || graceMinutes < 1) return [];
  let root: string;
  try {
    root = (await gitRun(repoRoot, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return [];
  }
  const worktreesDir = path.resolve(root, "..", ".worktrees");
  let entries: string[];
  try {
    entries = await fs.readdir(worktreesDir);
  } catch {
    return [];
  }

  const cutoff = Date.now() - graceMinutes * 60_000;
  const removed: string[] = [];

  for (const name of entries) {
    const wtPath = path.join(worktreesDir, name);
    let mtime: number;
    try {
      const st = await fs.stat(wtPath);
      if (!st.isDirectory()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtime >= cutoff) continue;

    // Capture branch before removing the worktree (so we can prune it after).
    let branch: string | null = null;
    try {
      branch = (await gitRun(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch {
      branch = null;
    }

    try {
      await gitRun(root, ["worktree", "remove", "--force", wtPath]);
      removed.push(wtPath);
    } catch {
      // Worktree may already be gone or locked — try a forceful rm so
      // we don't keep tripping on the same stale entry every startup.
      try {
        await fs.rm(wtPath, { recursive: true, force: true });
        await gitRun(root, ["worktree", "prune"]).catch(() => {});
        removed.push(wtPath);
      } catch {
        continue;
      }
    }

    if (branch && branch !== "HEAD") {
      // Only prune branches that look like ours: contain a "/" (so we
      // don't nuke `main`) and aren't the repo's current HEAD.
      if (branch.includes("/")) {
        await gitRun(root, ["branch", "-D", branch]).catch(() => {});
      }
    }
  }

  return removed;
}

/**
 * Unified diff for the working tree (vs HEAD). If `file` is provided,
 * limits to that path. Falls back to staged-only if working tree is
 * clean but index has changes.
 */
export async function getGitDiff(cwd: string, file?: string): Promise<string> {
  const baseArgs = ["diff", "--no-color", "--unified=3"];
  const args = file ? [...baseArgs, "--", file] : baseArgs;
  try {
    const wt = await gitRun(cwd, args);
    if (wt.trim()) return wt;
  } catch {
    // fall through
  }
  try {
    const staged = await gitRun(cwd, [...baseArgs, "--cached", ...(file ? ["--", file] : [])]);
    return staged;
  } catch {
    return "";
  }
}

export async function openExternal(url: string): Promise<void> {
  // Only allow http(s) and file URLs to be opened externally.
  if (!/^(https?:|file:)/i.test(url)) {
    throw new Error(`Refused to open URL with unsupported scheme: ${url}`);
  }
  await shell.openExternal(url);
}

export async function revealInFinder(targetPath: string): Promise<void> {
  const normalized = path.resolve(targetPath);
  shell.showItemInFolder(normalized);
}

function normalizeWorktreeName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "worktree";
}

