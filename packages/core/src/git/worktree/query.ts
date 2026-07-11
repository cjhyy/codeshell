import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SessionWorkspace } from "../../types.js";
import { getWorktreeDiff, type WorktreeDiffSummary } from "./diff.js";
import { execGit, gitOutput, normalizeBranchName } from "./git-exec.js";
import { isManagedWorktreeBranch } from "./slug.js";

export interface WorktreeWorkspaceOwner {
  sessionId: string;
  workspace?: SessionWorkspace;
}

export interface ListWorktreesFastOptions {
  currentSessionId?: string;
  workspaceOwners?: WorktreeWorkspaceOwner[];
  owners?: WorktreeWorkspaceOwner[];
  prefix?: string;
  signal?: AbortSignal;
}

export interface ListWorktreesOptions extends ListWorktreesFastOptions {
  includeDiffSummary?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain?: boolean;
  isManaged?: boolean;
  diff?: WorktreeDiffSummary;
  occupiedBySessionIds?: string[];
  occupiedByOtherSession?: boolean;
}

/**
 * Find the canonical git root (resolves worktree -> main repo).
 */
export async function findGitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return await findMainWorktreeRoot(cwd, signal);
}

export async function findMainWorktreeRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const commonDir = (
    await execGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5000, signal)
  ).trim();
  return dirname(commonDir);
}

export async function findWorktreeForBranch(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const normalized = normalizeBranchName(branch);
  return (await listWorktreesFast(cwd, { signal })).find((entry) => entry.branch === normalized)
    ?.path;
}

export async function assertBranchNotCheckedOut(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  const existingPath = await findWorktreeForBranch(cwd, branch, signal);
  if (existingPath) {
    throw new Error(`branch ${normalizeBranchName(branch)} already checked out at ${existingPath}`);
  }
}

export async function branchExists(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const out = await gitOutput(
    cwd,
    ["branch", "--list", normalizeBranchName(branch)],
    10000,
    signal,
  );
  return (out?.trim().length ?? 0) > 0;
}

export async function isGitWorktreeRoot(cwd: string, signal?: AbortSignal): Promise<boolean> {
  if (!existsSync(join(cwd, ".git"))) return false;
  try {
    const inside = (
      await execGit(cwd, ["rev-parse", "--is-inside-work-tree"], 5000, signal)
    ).trim();
    if (inside !== "true") return false;
    const topLevel = (
      await execGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"], 5000, signal)
    ).trim();
    return resolve(topLevel) === resolve(cwd);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

export async function currentBranch(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const branch = (await gitOutput(cwd, ["branch", "--show-current"], 5000, signal))?.trim();
  return branch || undefined;
}

export async function listWorktreesFast(
  cwd: string,
  opts: ListWorktreesFastOptions = {},
): Promise<WorktreeInfo[]> {
  let raw: string;
  try {
    raw = (await execGit(cwd, ["worktree", "list", "--porcelain"], 10000, opts.signal)).trim();
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return [];
  }

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
      current.branch = normalizeBranchName(line.slice(7));
    }
  }
  if (current.path) entries.push(current);

  let mainRoot = "";
  try {
    mainRoot = await findMainWorktreeRoot(cwd, opts.signal);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    mainRoot = entries[0]?.path ?? "";
  }

  const owners = opts.workspaceOwners ?? opts.owners ?? [];
  return entries.map((entry) => {
    const ownerIds = ownersForWorktree(entry.path, owners);
    return {
      ...entry,
      ...(mainRoot ? { isMain: resolve(entry.path) === resolve(mainRoot) } : {}),
      isManaged: Boolean(entry.branch) && isManagedWorktreeBranch(entry.branch, opts.prefix),
      ...(ownerIds.length > 0
        ? {
            occupiedBySessionIds: ownerIds,
            occupiedByOtherSession: ownerIds.some((id) => id !== opts.currentSessionId),
          }
        : {}),
    };
  });
}

/**
 * List active worktrees. Kept for internal/test compatibility; use
 * listWorktreesFast for UI lists that should not block on diff work.
 */
export async function listWorktrees(
  cwd: string,
  opts: ListWorktreesOptions = {},
): Promise<WorktreeInfo[]> {
  const entries = await listWorktreesFast(cwd, opts);
  if (!opts.includeDiffSummary) return entries;
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      diff: await getWorktreeDiff(entry.path),
    })),
  );
}

export function ownersForWorktree(path: string, owners: WorktreeWorkspaceOwner[]): string[] {
  const target = resolve(path);
  return owners
    .filter((owner) => {
      const workspace = owner.workspace;
      if (!workspace) return false;
      return resolve(workspace.root) === target;
    })
    .map((owner) => owner.sessionId);
}
