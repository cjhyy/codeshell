/**
 * Git worktree management — create/remove isolated worktrees for agents.
 */

import { execSync } from "node:child_process";
import { existsSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeSession {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalBranch?: string;
  sessionId: string;
  createdAt: number;
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
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
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
    originalBranch = execSync("git branch --show-current", {
      cwd: gitRoot,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    // Detached HEAD
  }

  // Create the worktree
  execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
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

/**
 * Remove a worktree and optionally its branch.
 */
export function removeWorktree(worktreePath: string, removeBranch = false): void {
  try {
    const gitRoot = findGitRoot(worktreePath);
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: gitRoot,
      timeout: 30000,
    });

    if (removeBranch) {
      // Extract branch name from worktree
      try {
        const branch = execSync("git branch --show-current", {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (branch.startsWith("worktree/")) {
          execSync(`git branch -D "${branch}"`, { cwd: gitRoot, timeout: 10000 });
        }
      } catch {
        // Branch might already be removed
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
  const raw = execSync("git worktree list --porcelain", {
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

  for (const dir of largeDirs) {
    const source = join(sourceRoot, dir);
    const target = join(worktreePath, dir);
    if (existsSync(source) && lstatSync(source).isDirectory() && !existsSync(target)) {
      try {
        symlinkSync(source, target, "dir");
      } catch {
        // Symlink might fail on some systems
      }
    }
  }
}
