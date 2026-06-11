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
  if (slug.length > 64) throw new Error("Worktree slug too long (max 64 chars)");
  if (/[^a-zA-Z0-9._-]/.test(slug)) throw new Error("Worktree slug contains invalid characters");
  if (slug.startsWith(".") || slug.includes("..")) throw new Error("Worktree slug cannot start with '.' or contain '..'");
}

/**
 * Find the canonical git root (resolves worktree → main repo).
 */
export function findGitRoot(cwd: string): string {
  return execFileSync(GIT_BIN, ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
}

/**
 * Create an isolated git worktree for an agent session.
 */
export function createWorktree(
  cwd: string,
  slug: string,
  sessionId: string,
): WorktreeSession {
  validateWorktreeSlug(slug);

  const gitRoot = findGitRoot(cwd);
  const branchName = `worktree/${slug}-${sessionId.slice(0, 8)}`;
  const worktreePath = resolve(gitRoot, "..", `.worktrees/${slug}-${sessionId.slice(0, 8)}`);

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

/**
 * Remove a worktree and optionally its branch.
 */
export function removeWorktree(worktreePath: string, removeBranch = false): void {
  try {
    // The MAIN repo root, not the worktree's own toplevel. `git rev-parse
    // --show-toplevel` from inside a worktree returns the worktree path, which
    // is about to be deleted; the branch-delete must run from the main repo,
    // which outlives the worktree. Derive it from the common git dir.
    const commonDir = execFileSync(
      GIT_BIN,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreePath, encoding: "utf-8", timeout: 5000 },
    ).trim();
    const mainRoot = dirname(commonDir); // <main>/.git → <main>

    // Capture the worktree's branch BEFORE removing the worktree — afterwards
    // the directory is gone and `git branch --show-current` in it would fail
    // (silently, leaving removeBranch a no-op).
    let branch = "";
    if (removeBranch) {
      try {
        branch = execFileSync(GIT_BIN, ["branch", "--show-current"], {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch {
        // Detached HEAD or unreadable — nothing to delete.
      }
    }

    execFileSync(GIT_BIN, ["worktree", "remove", worktreePath, "--force"], {
      cwd: mainRoot,
      timeout: 30000,
    });

    if (removeBranch && branch.startsWith("worktree/")) {
      try {
        execFileSync(GIT_BIN, ["branch", "-D", branch], { cwd: mainRoot, timeout: 10000 });
      } catch {
        // Branch might already be removed.
      }
    }
  } catch {
    // Worktree might already be removed
  }
}

/**
 * List active worktrees.
 */
export function listWorktrees(cwd: string): Array<{ path: string; branch: string; head: string }> {
  const raw = execFileSync(GIT_BIN, ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf-8",
    timeout: 10000,
  }).trim();

  if (!raw) return [];

  const entries: Array<{ path: string; branch: string; head: string }> = [];
  let current: { path: string; branch: string; head: string } = { path: "", branch: "", head: "" };

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

  return entries;
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
