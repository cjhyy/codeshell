import { BrowserWindow, ipcMain } from "electron";
import { normalizeWorktreeBranchPrefix } from "@cjhyy/code-shell-capability-coding/git";
import type { IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { StaleWorktreeCleanupSkipped } from "./git-services.js";
import { dlog } from "./desktop-logger.js";

export interface GitReviewIpcDeps {
  knownGitRoots: Set<string>;
  business: CallShellBusiness;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
}

/** Project git/branch routes, Session review routes and the stale-worktree sweep. */
export function registerGitReviewIpc(deps: GitReviewIpcDeps) {
  const { knownGitRoots } = deps;
  ipcMain.handle("git:projectSwitchBranch", (event, projectId: string, branch: string) =>
    deps.business(
      "git/switchProjectBranch",
      { projectId, branch, stash: false },
      deps.documentSignal(event),
    ),
  );
  ipcMain.handle("git:projectStashAndSwitchBranch", (event, projectId: string, branch: string) =>
    deps.business(
      "git/switchProjectBranch",
      { projectId, branch, stash: true },
      deps.documentSignal(event),
    ),
  );

  interface MainGitPrefs {
    branchPrefix: string;
    autoDeleteWorktrees: boolean;
    autoDeleteWorktreesGraceMins: number;
  }

  let gitPrefsCache: MainGitPrefs = {
    branchPrefix: "worktree/",
    autoDeleteWorktrees: false,
    autoDeleteWorktreesGraceMins: 60 * 24 * 7,
  };

  ipcMain.handle("git:setPrefs", async (_e, prefs: MainGitPrefs) => {
    if (!prefs || typeof prefs !== "object") return;
    const grace = Number(prefs.autoDeleteWorktreesGraceMins);
    let branchPrefix: string;
    try {
      branchPrefix = normalizeWorktreeBranchPrefix(prefs.branchPrefix);
    } catch {
      branchPrefix = "worktree/";
    }
    gitPrefsCache = {
      branchPrefix,
      autoDeleteWorktrees: prefs.autoDeleteWorktrees === true,
      autoDeleteWorktreesGraceMins:
        Number.isSafeInteger(grace) && grace >= 1
          ? Math.min(grace, 60 * 24 * 365 * 10)
          : 60 * 24 * 7,
    };
    dlog("main", "git.prefs.updated", { ...gitPrefsCache });
  });

  function broadcastWorktreeCleanupSkipped(
    root: string,
    skipped: StaleWorktreeCleanupSkipped[],
  ): void {
    if (skipped.length === 0) return;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send("git:worktreeCleanupSkipped", { root, skipped });
      }
    }
  }

  /**
   * Drives the worktree-cleanup sweep across every cwd the desktop has
   * touched this session (worktree create/list/diff/switch all funnel
   * through `cwd`). Each call is fire-and-forget; failures are logged
   * and never block the renderer.
   */
  async function sweepStaleWorktrees(reason: string): Promise<void> {
    if (!gitPrefsCache.autoDeleteWorktrees) return;
    if (knownGitRoots.size === 0) return;
    const grace = gitPrefsCache.autoDeleteWorktreesGraceMins;
    const branchPrefix = gitPrefsCache.branchPrefix;
    for (const root of knownGitRoots) {
      try {
        const result = await deps.business("git/sweepTracked", {
          root,
          graceMinutes: grace,
          prefix: branchPrefix,
        });
        if (result.removed.length > 0) {
          dlog("main", "git.worktree.cleanup", { reason, root, removed: result.removed });
        }
        if (result.skipped.length > 0) {
          dlog("main", "git.worktree.cleanup_skipped", {
            reason,
            root,
            skipped: result.skipped,
          });
          broadcastWorktreeCleanupSkipped(root, result.skipped);
        }
      } catch (e) {
        dlog("main", "git.worktree.cleanup_error", { root, error: String(e) });
      }
    }
  }
  return { sweepStaleWorktrees };
}
