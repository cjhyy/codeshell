/** Git worktree diff support owned by the coding capability. */
import { execGit, gitErrorMessage, gitOutput } from "./git-exec.js";

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
  const comparisonBase = await findSummaryComparisonBase(worktreePath, baseRef);
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

async function findSummaryComparisonBase(
  cwd: string,
  baseRef?: string,
): Promise<string | undefined> {
  const candidates = new Set([
    ...(baseRef ? [baseRef] : []),
    "main",
    "master",
    "origin/main",
    "origin/master",
  ]);
  for (const ref of candidates) {
    try {
      await execGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000);
      return ref;
    } catch (error) {
      // --verify --quiet exits with 1 for an absent ref. Infrastructure errors
      // must reach the UI instead of being reported as a clean workspace.
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
  }
  return undefined;
}

async function diffSummary(cwd: string, baseRef: string | undefined): Promise<WorktreeDiffSummary> {
  const [dirtyFiles, committedFiles, aheadCommits] = await Promise.all([
    statusFileSet(cwd),
    baseRef ? changedFilesSinceBase(cwd, baseRef) : Promise.resolve(new Set<string>()),
    baseRef ? readAheadCommitCount(cwd, baseRef) : Promise.resolve(0),
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
  let raw: string;
  try {
    raw = await execGit(cwd, ["diff", "--name-only", "-z", `${baseRef}...HEAD`]);
  } catch (error) {
    // Unrelated histories have no merge base. Keep the existing two-dot
    // comparison for that case, while surfacing timeouts and other failures.
    if (!/no merge base/i.test(gitErrorMessage(error))) throw error;
    raw = await execGit(cwd, ["diff", "--name-only", "-z", `${baseRef}..HEAD`]);
  }
  return new Set(raw.split("\0").filter(Boolean));
}

async function readAheadCommitCount(cwd: string, baseRef: string): Promise<number> {
  const out = await execGit(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const count = Number(out.trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Git returned an invalid ahead commit count");
  }
  return count;
}

async function aheadCommitCount(cwd: string, baseRef: string): Promise<number> {
  const out = await gitOutput(cwd, ["rev-list", "--count", `${baseRef}..HEAD`]);
  const n = Number.parseInt(out?.trim() ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

async function statusFileSet(cwd: string): Promise<Set<string>> {
  // Background summaries must not contend with a foreground Git operation for
  // the optional index refresh lock. NUL records preserve arbitrary file names.
  const raw = await execGit(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  const files = new Set<string>();
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const path = record.slice(3);
    if (!path) continue;
    files.add(path);
    // In porcelain -z, the destination comes first and the following NUL
    // record contains the source of a rename or copy.
    if (/[RC]/.test(record.slice(0, 2))) i += 1;
  }
  return files;
}
