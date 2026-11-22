import { isAbsolute } from "node:path";
import { normalizeWorktreeBranchPrefix } from "@cjhyy/code-shell-capability-coding/git";
import {
  requireRendererProjectPath,
  requireRendererProjectPrimary,
} from "../../main/renderer-project-path.js";
import {
  undoFiles,
  cleanupStaleWorktrees,
  stashAndSwitchGitBranch,
  switchGitBranch,
} from "../../main/git-services.js";
import type { GitOperations } from "../../shared/git-operations.js";
import { claimBusinessCommit, type BusinessMethods } from "./business-calls.js";

export function gitOperations() {
  const changing = new Map<string, Promise<unknown>>();
  return {
    "git/switchProjectBranch": async ({ projectId, branch, stash }, grant) => {
      if (
        typeof branch !== "string" ||
        !branch ||
        branch.length > 1024 ||
        branch.includes("\0") ||
        typeof stash !== "boolean"
      )
        throw Error("Invalid project branch");
      const first = await requireRendererProjectPrimary(projectId);
      // Keep a stash and its following switch together across simultaneous windows.
      const prior = changing.get(first.path);
      const action = Promise.resolve(prior)
        .catch(() => undefined)
        .then(async () => {
          grant.assertCurrent();
          return (stash ? stashAndSwitchGitBranch : switchGitBranch)(
            first.path,
            branch,
            async () => {
              const live = await requireRendererProjectPrimary(projectId);
              if (
                live.rootId !== first.rootId ||
                live.path !== first.path ||
                live.project.revision !== first.project.revision
              )
                throw Error("Project changed before switching branches");
              claimBusinessCommit(grant.permit);
            },
          );
        });
      changing.set(first.path, action);
      try {
        return await action;
      } finally {
        if (changing.get(first.path) === action) changing.delete(first.path);
      }
    },
    "git/undoFiles": async ({ cwd, paths }, grant) => {
      if (
        !Array.isArray(paths) ||
        !paths.length ||
        paths.length > 100 ||
        paths.some(
          (file) => typeof file !== "string" || !file || file.length > 32768 || file.includes("\0"),
        )
      ) {
        throw Error("Invalid files to undo");
      }
      const initial = await requireRendererProjectPath(cwd);
      let claimed = false;
      return undoFiles(initial, paths, async () => {
        if ((await requireRendererProjectPath(cwd)) !== initial)
          throw Error("Project changed before undo");
        grant.assertCurrent();
        if (!claimed) {
          claimBusinessCommit(grant.permit);
          claimed = true;
        }
      });
    },
    "git/sweepTracked": ({ root, graceMinutes, prefix }, grant) => {
      // Native lifecycle owns the set of roots reached via valid Session workspace operations.
      if (
        typeof root !== "string" ||
        !isAbsolute(root) ||
        root.includes("\0") ||
        !Number.isSafeInteger(graceMinutes) ||
        graceMinutes < 1 ||
        graceMinutes > 60 * 24 * 365 * 10
      )
        throw Error("Invalid tracked worktree sweep");
      const branchPrefix = normalizeWorktreeBranchPrefix(prefix);
      claimBusinessCommit(grant.permit);
      return cleanupStaleWorktrees(root, graceMinutes, branchPrefix);
    },
  } satisfies Pick<BusinessMethods, keyof GitOperations>;
}
