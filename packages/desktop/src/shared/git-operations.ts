import type {
  GitBranches,
  StaleWorktreeCleanupResult,
  UndoFilesResult,
} from "../main/git-services.js";

export interface GitOperations {
  "git/switchProjectBranch": {
    input: { projectId: string; branch: string; stash: boolean };
    result: GitBranches;
  };
  "git/undoFiles": {
    input: { cwd: string; paths: string[] };
    result: UndoFilesResult[];
  };
  "git/sweepTracked": {
    input: { root: string; graceMinutes: number; prefix: string };
    result: StaleWorktreeCleanupResult;
  };
}
