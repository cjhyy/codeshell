export interface ReviewRepositoryIdentity {
  /** Stable representative mounted root; the Session main root wins when present. */
  rootId: string;
  /** Every mounted root folded into this canonical Git repository. */
  rootIds: string[];
  /** Main-resolved canonical Git toplevel. Never accepted from the renderer. */
  repoRoot: string;
}

export interface ReviewRepositoryError extends Partial<ReviewRepositoryIdentity> {
  operation: "discover" | "status" | "diff" | "recent-commits";
  rootId: string;
  rootIds: string[];
  rootPath?: string;
  message: string;
}

export interface ReviewGitStatusEntry {
  code: string;
  path: string;
  rootId: string;
  repoRoot: string;
}

export interface ReviewGitStatusRepository extends ReviewRepositoryIdentity {
  branch: string | null;
  entries: ReviewGitStatusEntry[];
  clean: boolean;
}

export interface ReviewGitStatusResult {
  repositories: ReviewGitStatusRepository[];
  errors: ReviewRepositoryError[];
}

export type ReviewGitDiffRequest =
  | { kind: "working"; mode: "unstaged" | "staged" | "all" }
  | { kind: "branch" }
  | { kind: "committed"; rootId?: string; commitHash?: string };

export interface ReviewGitDiffRepository extends ReviewRepositoryIdentity {
  diff: string;
}

export interface ReviewGitDiffResult {
  repositories: ReviewGitDiffRepository[];
  errors: ReviewRepositoryError[];
}

export interface ReviewGitCommit extends ReviewRepositoryIdentity {
  hash: string;
  shortHash: string;
  subject: string;
  relativeDate: string;
}
