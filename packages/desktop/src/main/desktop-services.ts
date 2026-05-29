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
export async function getGitDiff(cwd: string, file?: string | string[]): Promise<string> {
  if (Array.isArray(file)) {
    const chunks = await Promise.all(file.map((f) => getGitDiffForFile(cwd, f)));
    return chunks.filter((chunk) => chunk.trim()).join("\n");
  }
  if (file) return getGitDiffForFile(cwd, file);

  const baseArgs = ["diff", "--no-color", "--unified=3"];
  const args = baseArgs;
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

async function getGitDiffForFile(cwd: string, file: string): Promise<string> {
  const baseArgs = ["diff", "--no-color", "--unified=3"];
  const args = [...baseArgs, "--", file];
  try {
    const wt = await gitRun(cwd, args);
    if (wt.trim()) return wt;
  } catch {
    // fall through
  }
  try {
    const staged = await gitRun(cwd, [...baseArgs, "--cached", "--", file]);
    if (staged.trim()) return staged;
  } catch {
    // fall through
  }
  if (await isUntrackedFile(cwd, file)) {
    return syntheticUntrackedDiff(cwd, file);
  }
  return "";
}

async function isUntrackedFile(cwd: string, file: string): Promise<boolean> {
  try {
    await gitRun(cwd, ["ls-files", "--error-unmatch", "--", file]);
    return false;
  } catch {
    // Not tracked. Only show a synthetic diff for files that actually exist.
  }
  const abs = path.resolve(cwd, file);
  const root = path.resolve(cwd);
  if (!abs.startsWith(root + path.sep) && abs !== root) return false;
  try {
    const stat = await fs.stat(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function syntheticUntrackedDiff(cwd: string, file: string): Promise<string> {
  const abs = path.resolve(cwd, file);
  let text: string;
  try {
    text = await fs.readFile(abs, "utf-8");
  } catch {
    return "";
  }
  if (text.includes("\0")) {
    return [
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      "@@ -0,0 +1 @@",
      "+(binary file)",
      "",
    ].join("\n");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const count = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${count} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
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

/**
 * Undo (revert) edits to the given paths in the working tree.
 *
 * For tracked files modified vs HEAD: `git restore --source=HEAD -- <path>`
 * — overwrites the working copy with the index-or-HEAD version, which
 * is what the user almost always means by "undo this edit".
 *
 * For untracked / newly-created files: `git ls-files --error-unmatch`
 * fails, so we delete the path from disk instead. We never `rm` a
 * tracked file — that would be surprising and easy to recover the
 * wrong direction from.
 *
 * Returns a per-path result so the renderer can surface partial
 * failures rather than aborting the whole batch on one bad apple.
 */
export interface UndoFilesResult {
  path: string;
  ok: boolean;
  action: "restore" | "remove" | "skip";
  error?: string;
}

export async function undoFiles(
  cwd: string,
  paths: string[],
): Promise<UndoFilesResult[]> {
  const results: UndoFilesResult[] = [];
  for (const rel of paths) {
    // Resolve under cwd; reject paths that escape it.
    const abs = path.resolve(cwd, rel);
    if (!abs.startsWith(path.resolve(cwd) + path.sep) && abs !== path.resolve(cwd)) {
      results.push({
        path: rel,
        ok: false,
        action: "skip",
        error: "refused: path escapes cwd",
      });
      continue;
    }
    // Tracked? `git ls-files --error-unmatch -- <path>` exits 0 if so.
    let tracked = false;
    try {
      await execFileAsync("git", ["ls-files", "--error-unmatch", "--", rel], {
        cwd,
      });
      tracked = true;
    } catch {
      tracked = false;
    }
    try {
      if (tracked) {
        await execFileAsync(
          "git",
          ["restore", "--source=HEAD", "--worktree", "--", rel],
          { cwd },
        );
        results.push({ path: rel, ok: true, action: "restore" });
      } else {
        // Untracked file — delete it from disk. Only do this if the
        // file actually exists; otherwise it's a no-op success.
        try {
          await fs.unlink(abs);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        results.push({ path: rel, ok: true, action: "remove" });
      }
    } catch (e: unknown) {
      results.push({
        path: rel,
        ok: false,
        action: tracked ? "restore" : "remove",
        error: String(e instanceof Error ? e.message : e),
      });
    }
  }
  return results;
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
export async function openPath(
  targetPath: string,
  cwd?: string,
): Promise<string> {
  // Strip a trailing :line[:col] suffix if present.
  const cleaned = targetPath.replace(/:(\d+)(?::(\d+))?$/, "");
  const absolute = path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(cwd ?? process.cwd(), cleaned);
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

function normalizeWorktreeName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "worktree";
}
