/**
 * write-run — orchestrate a write-type automation job in an isolated git
 * worktree (docs/automation-plan-2026-05-31.md, D6 / Phase 5).
 *
 * A write-type job must never touch the user's working copy: it runs in a
 * fresh worktree on its own branch, and if it produced changes, a PR is opened
 * from that branch. The worktree is always removed afterward.
 *
 * Git operations are injected (`WriteJobGitOps`) so the orchestration is
 * testable without a real repo and so hosts can supply their own git/PR
 * implementation (e.g. desktop reuses its existing worktree helpers; a server
 * host may shell out to `gh`).
 */

export interface WriteJobGitOps {
  /** Create a worktree off `gitRoot` on a fresh branch. Returns its path + branch. */
  createWorktree(gitRoot: string, slug: string): { path: string; branch: string };
  /** Does the worktree have uncommitted/committed changes worth a PR? */
  hasChanges(worktreePath: string): boolean;
  /** Open a PR from `branch`. Returns the PR url. */
  openPr(worktreePath: string, branch: string, title: string): { url: string };
  /** Remove the worktree (cleanup). */
  removeWorktree(worktreePath: string): void;
}

export interface RunWriteJobInput {
  gitRoot: string;
  slug: string;
  prTitle: string;
  git: WriteJobGitOps;
  /** Run the agent inside the given worktree cwd. */
  run: (cwd: string) => Promise<{ text: string; reason: string }>;
}

export interface RunWriteJobResult {
  text: string;
  reason: string;
  branch: string;
  prUrl: string | null;
}

/**
 * Create an isolated worktree, run the job inside it, open a PR if it produced
 * changes, then always clean up the worktree. Re-throws run errors after
 * cleanup so the scheduler's try/catch records the failure.
 */
export async function runWriteJobInWorktree(input: RunWriteJobInput): Promise<RunWriteJobResult> {
  const { path: wtPath, branch } = input.git.createWorktree(input.gitRoot, input.slug);
  try {
    const out = await input.run(wtPath);
    let prUrl: string | null = null;
    if (input.git.hasChanges(wtPath)) {
      prUrl = input.git.openPr(wtPath, branch, input.prTitle).url;
    }
    return { text: out.text, reason: out.reason, branch, prUrl };
  } finally {
    // Always remove the worktree — leaving stale worktrees around is a footgun.
    try {
      input.git.removeWorktree(wtPath);
    } catch {
      // best-effort cleanup
    }
  }
}
