import type { GitBranches, StaleWorktreeCleanupResult } from "../main/git-services.js";

export interface GitOperations {
  "git/switchProjectBranch": {
    input: { projectId: string; branch: string; stash: boolean };
    result: GitBranches;
  };
  "git/sweepTracked": {
    input: { root: string; graceMinutes: number; prefix: string };
    result: StaleWorktreeCleanupResult;
  };
}
