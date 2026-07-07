/**
 * Git worktree management — create/remove isolated worktrees for agents.
 */

import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { safeSpawnShell } from "../runtime/safe-spawn.js";
import { buildSandboxEnv, mergeShellEnv, defaultShellBinary } from "../runtime/spawn-common.js";
import { resolveExecutable } from "../utils/exec.js";
import type { SandboxBackend } from "../tool-system/sandbox/index.js";
import type { SessionWorkspace } from "../types.js";

// git resolved via PATH×PATHEXT on Windows (.cmd/.exe shim); no-op on POSIX.
const GIT_BIN = resolveExecutable("git");

export interface WorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalBranch?: string;
  sessionId: string;
  createdAt: number;
}

/** Per-platform setup/cleanup scripts (a project's localEnvironment). */
export interface PlatformScripts {
  default?: string;
  macos?: string;
  linux?: string;
  windows?: string;
}

/**
 * Pick the setup/cleanup script for the running platform, falling back to
 * `default`. Empty/whitespace-only scripts are treated as absent so a project
 * can leave a platform key blank without spawning an empty shell. `platform`
 * defaults to `process.platform` so callers usually omit it; tests pass a
 * fixed value.
 */
export function selectPlatformScript(
  scripts: PlatformScripts | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!scripts) return undefined;
  const key = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  // A blank platform key shouldn't shadow a real `default` — fall through.
  const platformScript = scripts[key]?.trim() ? scripts[key] : undefined;
  const candidate = platformScript ?? scripts.default;
  const trimmed = candidate?.trim();
  return trimmed ? candidate : undefined;
}

/**
 * Validate worktree slug to prevent path traversal attacks.
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.trim().length === 0) throw new Error("Worktree slug cannot be empty");
  if (slug.length > 64) throw new Error("Worktree slug too long (max 64 chars)");
  if (/[^a-zA-Z0-9._-]/.test(slug)) throw new Error("Worktree slug contains invalid characters");
  if (slug.startsWith(".") || slug.includes(".."))
    throw new Error("Worktree slug cannot start with '.' or contain '..'");
}

/**
 * Find the canonical git root (resolves worktree → main repo).
 */
export function findGitRoot(cwd: string): string {
  return findMainWorktreeRoot(cwd);
}

export function findMainWorktreeRoot(cwd: string): string {
  const commonDir = execFileSync(
    GIT_BIN,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    },
  ).trim();
  return dirname(commonDir);
}

export function findWorktreeForBranch(cwd: string, branch: string): string | undefined {
  const normalized = normalizeBranchName(branch);
  return listWorktrees(cwd).find((entry) => entry.branch === normalized)?.path;
}

export function assertBranchNotCheckedOut(cwd: string, branch: string): void {
  const existingPath = findWorktreeForBranch(cwd, branch);
  if (existingPath) {
    throw new Error(`branch ${normalizeBranchName(branch)} already checked out at ${existingPath}`);
  }
}

export function branchExists(cwd: string, branch: string): boolean {
  try {
    return (
      execFileSync(GIT_BIN, ["branch", "--list", normalizeBranchName(branch)], {
        cwd,
        encoding: "utf-8",
        timeout: 10000,
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

export function isGitWorktreeRoot(cwd: string): boolean {
  if (!existsSync(join(cwd, ".git"))) return false;
  try {
    const inside = execFileSync(GIT_BIN, ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (inside !== "true") return false;
    const topLevel = execFileSync(
      GIT_BIN,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      },
    ).trim();
    return resolve(topLevel) === resolve(cwd);
  } catch {
    return false;
  }
}

export function currentBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync(GIT_BIN, ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create an isolated git worktree for an agent session.
 */
export function createWorktree(cwd: string, slug: string, sessionId: string): WorktreeSession {
  validateWorktreeSlug(slug);

  const gitRoot = findGitRoot(cwd);
  const branchName = `worktree/${slug}-${sessionId.slice(0, 8)}`;
  const worktreePath = resolve(gitRoot, "..", `.worktrees/${slug}-${sessionId.slice(0, 8)}`);
  assertBranchNotCheckedOut(gitRoot, branchName);

  // Get current branch for later reference
  let originalBranch: string | undefined;
  try {
    originalBranch = execFileSync(GIT_BIN, ["branch", "--show-current"], {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    // Detached HEAD
  }

  // Create the worktree. Pre-fix this used a quoted command string; the argv
  // form keeps branchName/worktreePath as literal positional arguments even
  // if a future caller bypasses validateWorktreeSlug.
  execFileSync(GIT_BIN, ["worktree", "add", "-b", branchName, worktreePath], {
    cwd: gitRoot,
    timeout: 30000,
  });

  // Symlink large directories to avoid disk bloat
  symlinkLargeDirectories(gitRoot, worktreePath);

  return {
    originalCwd: cwd,
    worktreePath,
    worktreeName: slug,
    worktreeBranch: branchName,
    originalBranch,
    sessionId,
    createdAt: Date.now(),
  };
}

export interface WorktreeSetupResult {
  /** True if no setup script was configured for this platform (nothing ran). */
  skipped: boolean;
  /** True if a script ran and exited 0. */
  ok: boolean;
  /** Combined stdout/stderr, for surfacing to the user on failure. */
  output: string;
  /** Exit code when a script ran; undefined when skipped. */
  exitCode?: number | null;
}

/**
 * Run a project's `localEnvironment.setupScripts` once, in the freshly-created
 * worktree's root, right after `git worktree add`. This mirrors Codex's
 * local-environment semantics: setup belongs to the *worktree* lifecycle, not
 * the conversation — it runs when the isolated copy is born so e.g. `bun
 * install` or `cp .env.example .env` happens before the agent works there.
 *
 * Failure is non-fatal by design (Beta decision 2026-06-08, "警告但继续"): a
 * broken setup script shouldn't strand the agent outside a worktree it already
 * created. The caller surfaces `output` as a warning and proceeds. cleanup
 * scripts are intentionally NOT auto-run on exit (same decision).
 *
 * Reuses the same sandbox + env primitives as the Bash tool so the setup
 * command sees the project's `localEnvironment.env` and runs under the same
 * isolation the agent's later commands will.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  script: string | undefined,
  opts: {
    sandbox?: SandboxBackend;
    shellEnv?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WorktreeSetupResult> {
  const trimmed = script?.trim();
  if (!trimmed) return { skipped: true, ok: true, output: "" };

  const shell = defaultShellBinary();
  const backend = opts.sandbox;
  const baseEnv = backend && backend.name !== "off" ? buildSandboxEnv() : { ...process.env };
  const env = mergeShellEnv(baseEnv, opts.shellEnv);

  const result = await safeSpawnShell(trimmed, {
    cwd: worktreePath,
    env,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutputBytes: 1024 * 1024,
    sandbox: backend,
    shell,
    signal: opts.signal,
  });

  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  const output = parts.join("\n").trim();

  if (result.aborted) return { skipped: false, ok: false, output: output || "setup aborted" };
  if (result.timedOut) return { skipped: false, ok: false, output: output || "setup timed out" };
  if (result.spawnFailed) {
    return { skipped: false, ok: false, output: result.error ?? "failed to spawn setup script" };
  }
  return { skipped: false, ok: result.exitCode === 0, output, exitCode: result.exitCode };
}

export interface RemoveWorktreeResult {
  /** True once `git worktree remove` completed and the directory is gone. */
  dirRemoved: boolean;
  /** The branch targeted for deletion when removeBranch=true. */
  branch?: string;
  /** True when removeBranch=true and branch deletion completed. */
  branchDeleted?: boolean;
  /** Non-empty when the worktree directory is gone but branch deletion failed. */
  branchError?: string;
}

/**
 * Remove a worktree and optionally its branch.
 */
export function removeWorktree(worktreePath: string, removeBranch = false): RemoveWorktreeResult {
  // The MAIN repo root, not the worktree's own toplevel. `git rev-parse
  // --show-toplevel` from inside a worktree returns the worktree path, which
  // is about to be deleted; the branch-delete must run from the main repo,
  // which outlives the worktree. Derive it from the common git dir.
  let mainRoot: string;
  try {
    const commonDir = execFileSync(
      GIT_BIN,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreePath, encoding: "utf-8", timeout: 5000 },
    ).trim();
    mainRoot = dirname(commonDir); // <main>/.git → <main>
  } catch (err) {
    throw new Error(`failed to inspect worktree ${worktreePath}: ${gitErrorMessage(err)}`, {
      cause: err,
    });
  }

  // Capture the worktree's branch BEFORE removing the worktree — afterwards
  // the directory is gone and `git branch --show-current` in it would fail.
  let branch = "";
  if (removeBranch) {
    try {
      branch = execFileSync(GIT_BIN, ["branch", "--show-current"], {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch (err) {
      throw new Error(
        `failed to determine branch for worktree ${worktreePath}: ${gitErrorMessage(err)}`,
        { cause: err },
      );
    }
    if (!branch) {
      throw new Error(`failed to determine branch for worktree ${worktreePath}`);
    }
    if (!branch.startsWith("worktree/")) {
      throw new Error(`refusing to delete non-CodeShell worktree branch ${branch}`);
    }
  }

  try {
    execFileSync(GIT_BIN, ["worktree", "remove", worktreePath, "--force"], {
      cwd: mainRoot,
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(`failed to remove worktree ${worktreePath}: ${gitErrorMessage(err)}`, {
      cause: err,
    });
  }

  if (removeBranch) {
    try {
      execFileSync(GIT_BIN, ["branch", "-D", branch], { cwd: mainRoot, timeout: 10000 });
    } catch (err) {
      return {
        dirRemoved: true,
        branch,
        branchDeleted: false,
        branchError: gitErrorMessage(err),
      };
    }
  }
  return removeBranch ? { dirRemoved: true, branch, branchDeleted: true } : { dirRemoved: true };
}

export function worktreeHasUncommittedChanges(worktreePath: string): boolean {
  try {
    return (
      execFileSync(GIT_BIN, ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 10000,
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

export function worktreeHasUncommittedOrAheadChanges(
  worktreePath: string,
  baseRef?: string,
): boolean {
  if (worktreeHasUncommittedChanges(worktreePath)) return true;
  const comparisonBase =
    baseRef && commitRefExists(worktreePath, baseRef)
      ? baseRef
      : findComparisonBaseRef(worktreePath);
  return comparisonBase ? aheadCommitCount(worktreePath, comparisonBase) > 0 : false;
}

export interface WorktreeDiffSummary {
  /** Best-effort base used for the branch comparison, usually main/master. */
  baseRef?: string;
  /** Unique files changed either by commits ahead of base or by uncommitted changes. */
  changedFiles: number;
  /** Commits reachable from HEAD but not from baseRef. */
  aheadCommits: number;
  /** True when `git status --porcelain` reports local changes. */
  hasUncommittedChanges: boolean;
}

export interface WorktreeWorkspaceOwner {
  sessionId: string;
  workspace?: SessionWorkspace;
}

export interface ListWorktreesOptions {
  includeDiffSummary?: boolean;
  currentSessionId?: string;
  workspaceOwners?: WorktreeWorkspaceOwner[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain?: boolean;
  diff?: WorktreeDiffSummary;
  occupiedBySessionIds?: string[];
  occupiedByOtherSession?: boolean;
}

/**
 * List active worktrees.
 */
export function listWorktrees(cwd: string, opts: ListWorktreesOptions = {}): WorktreeInfo[] {
  const raw = execFileSync(GIT_BIN, ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf-8",
    timeout: 10000,
  }).trim();

  if (!raw) return [];

  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo = { path: "", branch: "", head: "" };

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice(9), branch: "", head: "" };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5, 13);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    }
  }
  if (current.path) entries.push(current);

  if (!opts.includeDiffSummary && !opts.workspaceOwners?.length) return entries;

  let mainRoot = "";
  try {
    mainRoot = findMainWorktreeRoot(cwd);
  } catch {
    mainRoot = entries[0]?.path ?? "";
  }
  const baseRef = opts.includeDiffSummary ? findComparisonBaseRef(mainRoot || cwd) : undefined;

  return entries.map((entry) => {
    const owners = ownersForWorktree(entry.path, opts.workspaceOwners ?? []);
    return {
      ...entry,
      ...(mainRoot ? { isMain: resolve(entry.path) === resolve(mainRoot) } : {}),
      ...(opts.includeDiffSummary ? { diff: diffSummary(entry.path, baseRef) } : {}),
      ...(owners.length > 0
        ? {
            occupiedBySessionIds: owners,
            occupiedByOtherSession: owners.some((id) => id !== opts.currentSessionId),
          }
        : {}),
    };
  });
}

function ownersForWorktree(path: string, owners: WorktreeWorkspaceOwner[]): string[] {
  const target = resolve(path);
  return owners
    .filter((owner) => {
      const workspace = owner.workspace;
      if (!workspace) return false;
      return resolve(workspace.root) === target;
    })
    .map((owner) => owner.sessionId);
}

function findComparisonBaseRef(cwd: string): string | undefined {
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    if (commitRefExists(cwd, ref)) return ref;
  }
  return undefined;
}

function commitRefExists(cwd: string, ref: string): boolean {
  try {
    execFileSync(GIT_BIN, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function diffSummary(cwd: string, baseRef: string | undefined): WorktreeDiffSummary {
  const dirtyFiles = statusFileSet(cwd);
  const committedFiles = baseRef ? changedFilesSinceBase(cwd, baseRef) : new Set<string>();
  const changedFiles = new Set([...dirtyFiles, ...committedFiles]);
  return {
    ...(baseRef ? { baseRef } : {}),
    changedFiles: changedFiles.size,
    aheadCommits: baseRef ? aheadCommitCount(cwd, baseRef) : 0,
    hasUncommittedChanges: dirtyFiles.size > 0,
  };
}

function changedFilesSinceBase(cwd: string, baseRef: string): Set<string> {
  const out = gitOutput(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const raw = out ?? gitOutput(cwd, ["diff", "--name-only", `${baseRef}..HEAD`]) ?? "";
  return new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function aheadCommitCount(cwd: string, baseRef: string): number {
  const out = gitOutput(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const n = Number.parseInt(out?.trim() ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function statusFileSet(cwd: string): Set<string> {
  const raw = gitOutput(cwd, ["status", "--porcelain=v1"]) ?? "";
  const files = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3).trim();
    if (!path) continue;
    const renameTarget = path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
    if (renameTarget) files.add(unquoteGitPath(renameTarget));
  }
  return files;
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync(GIT_BIN, args, {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    return undefined;
  }
}

function gitErrorMessage(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  if (Buffer.isBuffer(stderr)) {
    const msg = stderr.toString("utf-8").trim();
    if (msg) return msg;
  }
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

/**
 * Symlink large directories (node_modules, .venv, etc.) from main repo to worktree.
 */
function symlinkLargeDirectories(sourceRoot: string, worktreePath: string): void {
  const largeDirs = ["node_modules", ".venv", "vendor", ".pnpm-store"];

  // Windows directory symlinks need admin/Developer Mode and throw EPERM for a
  // normal user; NTFS junctions don't and behave the same for our purpose
  // (share node_modules into the worktree). Use "junction" on win32, "dir"
  // elsewhere. Failure stays non-fatal — the worktree just doesn't share dirs.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  for (const dir of largeDirs) {
    const source = join(sourceRoot, dir);
    const target = join(worktreePath, dir);
    if (existsSync(source) && lstatSync(source).isDirectory() && !existsSync(target)) {
      try {
        symlinkSync(source, target, linkType);
      } catch {
        // Symlink/junction might fail on some systems — non-fatal, the
        // worktree just won't share this directory (more disk, still works).
      }
    }
  }
}
