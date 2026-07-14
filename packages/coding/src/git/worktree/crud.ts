import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildSandboxEnv,
  defaultShellBinary,
  mergeShellEnv,
  safeSpawnShell,
  type SandboxBackend,
} from "@cjhyy/code-shell-core";
import { execGit, execGitSync, gitErrorMessage } from "./git-exec.js";
import { assertBranchNotCheckedOut, currentBranch, findGitRoot } from "./query.js";
import { applyPrefix, isManagedWorktreeBranch, validateWorktreeSlug } from "./slug.js";

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

export interface CreateWorktreeOptions {
  prefix?: string;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Best-effort rollback for an aborted `git worktree add`. */
export async function cleanupAbortedWorktree(
  gitRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  try {
    await execGit(gitRoot, ["worktree", "remove", worktreePath, "--force"], 30_000);
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await execGit(gitRoot, ["worktree", "prune"], 10_000).catch(() => {});
  }
  await execGit(gitRoot, ["branch", "-D", branchName], 10_000).catch(() => {});
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
 * Create an isolated git worktree for an agent session.
 */
export async function createWorktree(
  cwd: string,
  slug: string,
  sessionId: string,
  opts: CreateWorktreeOptions = {},
): Promise<WorktreeSession> {
  validateWorktreeSlug(slug);
  throwIfAborted(opts.signal);

  const gitRoot = await findGitRoot(cwd);
  throwIfAborted(opts.signal);
  const branchName = applyPrefix(opts.prefix, slug, sessionId);
  const worktreePath = resolve(gitRoot, "..", `.worktrees/${slug}-${sessionId.slice(0, 8)}`);
  await assertBranchNotCheckedOut(gitRoot, branchName);
  throwIfAborted(opts.signal);

  const originalBranch = await currentBranch(gitRoot);
  throwIfAborted(opts.signal);

  // The argv form keeps branchName/worktreePath as literal positional
  // arguments even if a future caller bypasses validateWorktreeSlug.
  try {
    await execGit(
      gitRoot,
      ["worktree", "add", "-b", branchName, worktreePath],
      30_000,
      opts.signal,
    );
    throwIfAborted(opts.signal);

    // Symlink large directories to avoid disk bloat.
    symlinkLargeDirectories(gitRoot, worktreePath);
    throwIfAborted(opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) {
      await cleanupAbortedWorktree(gitRoot, worktreePath, branchName);
    }
    throw error;
  }

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
 * worktree's root, right after `git worktree add`.
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

export interface RemoveWorktreeOptions {
  prefix?: string;
}

/**
 * Remove a worktree and optionally its branch.
 */
export function removeWorktree(
  worktreePath: string,
  removeBranch = false,
  opts: RemoveWorktreeOptions = {},
): RemoveWorktreeResult {
  // The MAIN repo root, not the worktree's own toplevel. `git rev-parse
  // --show-toplevel` from inside a worktree returns the worktree path, which
  // is about to be deleted; the branch-delete must run from the main repo,
  // which outlives the worktree. Derive it from the common git dir.
  let mainRoot: string;
  try {
    const commonDir = execGitSync(
      worktreePath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      5000,
    ).trim();
    mainRoot = dirname(commonDir);
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
      branch = execGitSync(worktreePath, ["branch", "--show-current"], 5000).trim();
    } catch (err) {
      throw new Error(
        `failed to determine branch for worktree ${worktreePath}: ${gitErrorMessage(err)}`,
        { cause: err },
      );
    }
    if (!branch) {
      throw new Error(`failed to determine branch for worktree ${worktreePath}`);
    }
    if (!isManagedWorktreeBranch(branch, opts.prefix)) {
      throw new Error(`refusing to delete non-CodeShell worktree branch ${branch}`);
    }
  }

  try {
    execGitSync(mainRoot, ["worktree", "remove", worktreePath, "--force"], 30000);
  } catch (err) {
    throw new Error(`failed to remove worktree ${worktreePath}: ${gitErrorMessage(err)}`, {
      cause: err,
    });
  }

  if (removeBranch) {
    try {
      execGitSync(mainRoot, ["branch", "-D", branch], 10000);
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

/**
 * Symlink large directories (node_modules, .venv, etc.) from main repo to
 * worktree. Also links each monorepo workspace package's private
 * `node_modules` (e.g. `packages/desktop/node_modules`, where bun keeps
 * un-hoisted deps like electron) so a fresh worktree can build/run the whole
 * workspace, not just the packages whose deps happen to be hoisted to the root.
 */
function symlinkLargeDirectories(sourceRoot: string, worktreePath: string): void {
  const largeDirs = ["node_modules", ".venv", "vendor", ".pnpm-store"];
  for (const dir of largeDirs) {
    linkDir(join(sourceRoot, dir), join(worktreePath, dir));
  }

  // Monorepo workspace packages keep private node_modules that are NOT hoisted
  // to the root. Link `<pkg>/node_modules` for each package under `packages/`.
  const packagesDir = join(sourceRoot, "packages");
  if (!dirExists(packagesDir)) return;
  let pkgNames: string[];
  try {
    pkgNames = readdirSync(packagesDir);
  } catch {
    return;
  }
  for (const pkg of pkgNames) {
    const source = join(packagesDir, pkg, "node_modules");
    if (!dirExists(source)) continue;
    const targetPkgDir = join(worktreePath, "packages", pkg);
    // The worktree only has package dirs that exist in this branch's tree; a
    // package present in the main repo but not checked out here is skipped.
    if (!dirExists(targetPkgDir)) {
      try {
        mkdirSync(targetPkgDir, { recursive: true });
      } catch {
        continue;
      }
    }
    linkDir(source, join(targetPkgDir, "node_modules"));
  }
}

function dirExists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function linkDir(source: string, target: string): void {
  // Windows directory symlinks need admin/Developer Mode and throw EPERM for a
  // normal user; NTFS junctions don't and behave the same for our purpose.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (dirExists(source) && !existsSync(target)) {
    try {
      symlinkSync(source, target, linkType);
    } catch {
      // Symlink/junction might fail on some systems — non-fatal.
    }
  }
}
