import { BrowserWindow, ipcMain } from "electron";
import { normalizeWorktreeBranchPrefix } from "@cjhyy/code-shell-capability-coding/git";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import { dlog } from "./desktop-logger.js";
import {
  getGitStatus,
  getGitBranches,
  switchGitBranch,
  stashAndSwitchGitBranch,
  cleanupStaleWorktrees,
  type StaleWorktreeCleanupSkipped,
} from "./desktop-services.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { reviewService } from "./review-service.js";

export interface GitReviewIpcDeps {
  knownGitRoots: Set<string>;
}

/** Project git/branch routes, Session review routes and the stale-worktree sweep. */
export function registerGitReviewIpc(deps: GitReviewIpcDeps) {
  const { knownGitRoots } = deps;
  ipcMain.handle("git:projectStatus", async (_e, projectId: string) => {
    const { path } = await requireRendererProjectPrimary(projectId);
    return getGitStatus(path);
  });

  ipcMain.handle("git:projectBranches", async (_e, projectId: string) => {
    const { path } = await requireRendererProjectPrimary(projectId);
    return getGitBranches(path);
  });

  ipcMain.handle("git:projectSwitchBranch", async (_e, projectId: string, branch: string) => {
    if (typeof branch !== "string" || !branch || branch.length > 1_024 || branch.includes("\0")) {
      throw new Error("git:projectSwitchBranch requires a bounded branch");
    }
    const { path } = await requireRendererProjectPrimary(projectId);
    return switchGitBranch(path, branch);
  });

  ipcMain.handle(
    "git:projectStashAndSwitchBranch",
    async (_e, projectId: string, branch: string) => {
      if (typeof branch !== "string" || !branch || branch.length > 1_024 || branch.includes("\0")) {
        throw new Error("git:projectStashAndSwitchBranch requires a bounded branch");
      }
      const { path } = await requireRendererProjectPrimary(projectId);
      return stashAndSwitchGitBranch(path, branch);
    },
  );

  ipcMain.handle("review:status", async (_e, sessionId: string) => {
    assertDesktopSessionId(sessionId);
    return reviewService.getStatus(sessionId);
  });

  ipcMain.handle("review:diff", async (_e, sessionId: string, request: unknown) => {
    assertDesktopSessionId(sessionId);
    return reviewService.getDiff(
      sessionId,
      request as import("../shared/review.js").ReviewGitDiffRequest,
    );
  });

  ipcMain.handle("review:recentCommits", async (_e, sessionId: string, limit?: number) => {
    assertDesktopSessionId(sessionId);
    return reviewService.getRecentCommits(sessionId, limit);
  });

  ipcMain.handle("review:preparePrompt", async (_e, sessionId: string, request: unknown) => {
    assertDesktopSessionId(sessionId);
    return reviewService.preparePrompt(
      sessionId,
      request as import("../shared/review.js").ReviewAiPromptRequest,
    );
  });

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
        const result = await cleanupStaleWorktrees(root, grace, branchPrefix);
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
