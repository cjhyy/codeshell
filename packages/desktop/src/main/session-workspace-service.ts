import { isAbsolute, resolve } from "node:path";
import {
  createWorktree,
  currentBranch,
  findMainWorktreeRoot,
  listWorktrees,
  removeWorktree,
  SessionManager,
  validateWorktreeSlug,
  worktreeHasUncommittedOrAheadChanges,
  type SessionWorkspace,
  type WorktreeInfo,
  type WorktreeWorkspaceOwner,
} from "@cjhyy/code-shell-core";

export type WorkspaceCleanupAction = "detach" | "discard";

export interface SessionWorkspaceList {
  current: SessionWorkspace;
  mainRoot: string;
  worktrees: WorktreeInfo[];
}

function sessions(): SessionManager {
  return new SessionManager();
}

function workspaceOwners(sm: SessionManager): WorktreeWorkspaceOwner[] {
  return sm.list(10_000).map((state) => ({
    sessionId: state.sessionId,
    workspace: state.workspace ?? { root: state.cwd, kind: "main" },
  }));
}

function mainRootFor(sm: SessionManager, sessionId: string, cwd: string): string {
  const fromSession = sm.readCwd(sessionId);
  if (fromSession) return fromSession;
  return findMainWorktreeRoot(cwd);
}

function currentWorkspaceFor(
  sm: SessionManager,
  sessionId: string,
  mainRoot: string,
): SessionWorkspace {
  return sm.getSessionWorkspace(sessionId) ?? { root: mainRoot, kind: "main" };
}

function requireKnownSession(sm: SessionManager, sessionId: string): void {
  if (!sm.exists(sessionId)) {
    throw new Error(`unknown session: ${sessionId}`);
  }
  if (sm.readCwd(sessionId) === undefined) {
    throw new Error("session exists but has no valid state — cannot perform workspace operations");
  }
}

export function getSessionWorkspaceForUi(sessionId: string, cwd: string): SessionWorkspace {
  const sm = sessions();
  const mainRoot = mainRootFor(sm, sessionId, cwd);
  return currentWorkspaceFor(sm, sessionId, mainRoot);
}

export function listSessionWorktreesForUi(sessionId: string, cwd: string): SessionWorkspaceList {
  const sm = sessions();
  const mainRoot = mainRootFor(sm, sessionId, cwd);
  const current = currentWorkspaceFor(sm, sessionId, mainRoot);
  return {
    current,
    mainRoot,
    worktrees: listWorktrees(mainRoot, {
      includeDiffSummary: true,
      currentSessionId: sessionId,
      workspaceOwners: workspaceOwners(sm),
    }),
  };
}

export function switchSessionWorkspaceForUi(
  sessionId: string,
  cwd: string,
  target: string,
): SessionWorkspaceList {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const trimmed = target.trim();
  if (!trimmed) throw new Error("target is required");
  const mainRoot = mainRootFor(sm, sessionId, cwd);
  const from = currentWorkspaceFor(sm, sessionId, mainRoot);

  let next: SessionWorkspace;
  if (trimmed === "main") {
    next = { root: mainRoot, kind: "main" };
  } else {
    const entries = listWorktrees(mainRoot);
    const pathTarget = pathLike(trimmed) ? resolvePathTarget(trimmed, from.root) : undefined;
    const branchTarget = normalizeBranchName(trimmed);
    const match = entries.find((entry) => {
      if (pathTarget && resolve(entry.path) === pathTarget) return true;
      return entry.branch === branchTarget;
    });

    if (match) {
      next = worktreeWorkspaceFromEntry(match, from, mainRoot);
    } else {
      if (pathTarget) throw new Error(`no existing worktree found at ${trimmed}`);
      validateWorktreeSlug(trimmed);
      const created = createWorktree(mainRoot, trimmed, sessionId);
      next = {
        root: created.worktreePath,
        kind: "worktree",
        worktree: {
          path: created.worktreePath,
          branch: created.worktreeBranch,
          baseRef: created.originalBranch ?? currentBranch(mainRoot) ?? "HEAD",
          createdBy: "codeshell",
        },
      };
    }
  }

  sm.setSessionWorkspace(sessionId, next);
  sm.recordWorkspaceHandoff(sessionId, from, next);
  return listSessionWorktreesForUi(sessionId, mainRoot);
}

export function cleanupSessionWorktreeForUi(
  sessionId: string,
  cwd: string,
  worktreePath: string,
  action: WorkspaceCleanupAction,
): SessionWorkspaceList {
  if (action !== "detach" && action !== "discard") {
    throw new Error("action must be detach or discard");
  }
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const mainRoot = mainRootFor(sm, sessionId, cwd);
  const current = currentWorkspaceFor(sm, sessionId, mainRoot);
  const entries = listWorktrees(mainRoot, {
    currentSessionId: sessionId,
    workspaceOwners: workspaceOwners(sm),
  });
  const match = entries.find((entry) => resolve(entry.path) === resolve(worktreePath));
  if (!match) throw new Error(`worktree not found: ${worktreePath}`);
  if (resolve(match.path) === resolve(mainRoot))
    throw new Error("cannot clean up the main workspace");
  if (match.occupiedByOtherSession) {
    throw new Error("worktree is occupied by another session");
  }

  const baseRef =
    current.kind === "worktree" && resolve(current.root) === resolve(match.path)
      ? current.worktree?.baseRef
      : undefined;
  const dirty = worktreeHasUncommittedOrAheadChanges(match.path, baseRef);
  if (action === "detach" && dirty) {
    throw new Error(
      "detach would drop uncommitted changes or new commits. Choose discard to delete the worktree and branch.",
    );
  }

  // A discard can remove the directory but leave branch deletion for manual
  // cleanup. That still returns normally so the active session pointer below
  // moves back to main instead of staying on a removed directory.
  removeWorktree(match.path, action === "discard");
  if (current.kind === "worktree" && resolve(current.root) === resolve(match.path)) {
    const mainWorkspace: SessionWorkspace = { root: mainRoot, kind: "main" };
    sm.setSessionWorkspace(sessionId, mainWorkspace);
    sm.recordWorkspaceHandoff(sessionId, current, mainWorkspace);
  }
  return listSessionWorktreesForUi(sessionId, mainRoot);
}

function worktreeWorkspaceFromEntry(
  entry: WorktreeInfo,
  current: SessionWorkspace,
  mainRoot: string,
): SessionWorkspace {
  if (!entry.branch) throw new Error("cannot switch to a detached worktree");
  const previous =
    current.kind === "worktree" &&
    current.worktree &&
    resolve(current.worktree.path) === resolve(entry.path)
      ? current.worktree
      : undefined;
  return {
    root: entry.path,
    kind: "worktree",
    worktree: {
      path: entry.path,
      branch: entry.branch,
      baseRef: previous?.baseRef ?? currentBranch(mainRoot) ?? "HEAD",
      createdBy: "codeshell",
    },
  };
}

function pathLike(target: string): boolean {
  return (
    isAbsolute(target) || target.startsWith(".") || target.includes("/") || target.includes("\\")
  );
}

function resolvePathTarget(target: string, cwd: string): string {
  return resolve(cwd, target);
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}
