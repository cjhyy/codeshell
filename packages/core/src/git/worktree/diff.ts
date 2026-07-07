import { gitOutput } from "./git-exec.js";

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

export async function getWorktreeDiff(
  worktreePath: string,
  baseRef?: string,
): Promise<WorktreeDiffSummary> {
  const comparisonBase =
    baseRef && (await commitRefExists(worktreePath, baseRef))
      ? baseRef
      : await findComparisonBaseRef(worktreePath);
  return diffSummary(worktreePath, comparisonBase);
}

export async function worktreeHasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const out = await gitOutput(worktreePath, ["status", "--porcelain"], 10000);
  return (out?.trim().length ?? 0) > 0;
}

export async function worktreeHasUncommittedOrAheadChanges(
  worktreePath: string,
  baseRef?: string,
): Promise<boolean> {
  if (await worktreeHasUncommittedChanges(worktreePath)) return true;
  const comparisonBase =
    baseRef && (await commitRefExists(worktreePath, baseRef))
      ? baseRef
      : await findComparisonBaseRef(worktreePath);
  return comparisonBase ? (await aheadCommitCount(worktreePath, comparisonBase)) > 0 : false;
}

export async function findComparisonBaseRef(cwd: string): Promise<string | undefined> {
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    if (await commitRefExists(cwd, ref)) return ref;
  }
  return undefined;
}

async function commitRefExists(cwd: string, ref: string): Promise<boolean> {
  const out = await gitOutput(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000);
  return out !== undefined;
}

async function diffSummary(cwd: string, baseRef: string | undefined): Promise<WorktreeDiffSummary> {
  const [dirtyFiles, committedFiles, aheadCommits] = await Promise.all([
    statusFileSet(cwd),
    baseRef ? changedFilesSinceBase(cwd, baseRef) : Promise.resolve(new Set<string>()),
    baseRef ? aheadCommitCount(cwd, baseRef) : Promise.resolve(0),
  ]);
  const changedFiles = new Set([...dirtyFiles, ...committedFiles]);
  return {
    ...(baseRef ? { baseRef } : {}),
    changedFiles: changedFiles.size,
    aheadCommits,
    hasUncommittedChanges: dirtyFiles.size > 0,
  };
}

async function changedFilesSinceBase(cwd: string, baseRef: string): Promise<Set<string>> {
  const out = await gitOutput(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const raw = out ?? (await gitOutput(cwd, ["diff", "--name-only", `${baseRef}..HEAD`])) ?? "";
  return new Set(
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function aheadCommitCount(cwd: string, baseRef: string): Promise<number> {
  const out = await gitOutput(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const n = Number.parseInt(out?.trim() ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

async function statusFileSet(cwd: string): Promise<Set<string>> {
  const raw = (await gitOutput(cwd, ["status", "--porcelain=v1"])) ?? "";
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
