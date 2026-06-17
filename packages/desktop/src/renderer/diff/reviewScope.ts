import type { GitStatusEntry } from "../../preload/types";

/**
 * Review scopes for the panel (TODO 2.3a). Default is "turn" when opened from a
 * turn's "files changed" card — that was the bug: clicking 审查 dropped you into
 * the whole working tree instead of just what the turn changed.
 *
 *   turn     — exactly the files the originating turn edited (caller-supplied)
 *   unstaged — working-tree changes not yet staged (porcelain Y ≠ space)
 *   staged   — index changes staged for commit (porcelain X ≠ space)
 *   all       — every uncommitted change (the old behavior)
 *   committed — the last commit (HEAD~1..HEAD), a committed git range
 *   branch    — this branch vs its base (main/master/upstream...HEAD)
 *
 * committed/branch are "range" scopes: their entries + per-file diffs come from
 * a committed git range, not the working tree (see isRangeScope).
 */
export type ReviewScope = "turn" | "unstaged" | "staged" | "all" | "committed" | "branch";

// Scope ids only — display labels live in the i18n dict
// (`panels.review.scopes.<id>`) and are resolved at the call site (ReviewPanel),
// since this is a React-free module with no access to the `t()` hook.
export const REVIEW_SCOPES: { id: ReviewScope }[] = [
  { id: "turn" },
  { id: "unstaged" },
  { id: "staged" },
  { id: "all" },
  { id: "committed" },
  { id: "branch" },
];

/** True for scopes sourced from a committed git range (not the working tree). */
export function isRangeScope(scope: ReviewScope): boolean {
  return scope === "committed" || scope === "branch";
}

/** porcelain v1 code is "XY": X = index/staged slot, Y = worktree/unstaged slot. */
function indexCode(code: string): string {
  return code[0] ?? " ";
}
function worktreeCode(code: string): string {
  return code[1] ?? " ";
}

/** True if the entry has a staged (index) change. "??" (untracked) is NOT staged. */
export function isStaged(e: GitStatusEntry): boolean {
  if (e.code === "??") return false;
  const x = indexCode(e.code);
  return x !== " " && x !== "?";
}

/** True if the entry has an unstaged (worktree) change, including untracked. */
export function isUnstaged(e: GitStatusEntry): boolean {
  if (e.code === "??") return true;
  const y = worktreeCode(e.code);
  return y !== " ";
}

/**
 * Filter git-status entries to a scope. For "turn", `turnFiles` is the
 * caller-supplied set (paths, relative to cwd as git reports them); we keep
 * status entries whose path is in that set so the file tree shows real status
 * codes for exactly the turn's files. Unknown scope → all entries.
 */
export function filterByScope(
  entries: GitStatusEntry[],
  scope: ReviewScope,
  turnFiles?: string[],
): GitStatusEntry[] {
  switch (scope) {
    case "turn": {
      if (!turnFiles || turnFiles.length === 0) return entries;
      const set = new Set(turnFiles.map(normalizePath));
      return entries.filter((e) => set.has(normalizePath(e.path)));
    }
    case "staged":
      return entries.filter(isStaged);
    case "unstaged":
      return entries.filter(isUnstaged);
    case "all":
    default:
      return entries;
  }
}

/** Strip a trailing slash and leading "./" so turn-file paths and git paths compare. */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}
