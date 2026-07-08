import { isAbsolute, resolve } from "node:path";
import {
  createWorktree,
  currentBranch,
  findMainWorktreeRoot,
  getWorktreeDiff,
  listWorktreesFast,
  removeWorktree,
  SessionManager,
  SettingsManager,
  validateWorktreeSlug,
  worktreeHasUncommittedOrAheadChanges,
  type SessionWorkspace,
  type WorktreeDiffSummary,
  type WorktreeInfo,
  type WorktreeWorkspaceOwner,
} from "@cjhyy/code-shell-core";

export type WorkspaceCleanupAction = "detach" | "discard";

export interface SessionWorkspaceList {
  current: SessionWorkspace;
  mainRoot: string;
  worktrees: WorktreeInfo[];
}

export interface ReleasedSessionWorkspace {
  sessionId: string;
  ok: true;
  status: "released";
  workspace: SessionWorkspace;
}

export interface MissingSessionWorkspaceRelease {
  sessionId: string;
  ok: true;
  status: "missing";
  reason: string;
}

export interface FailedSessionWorkspaceRelease {
  sessionId: string;
  ok: false;
  status: "error";
  error: string;
}

export type SessionWorkspaceReleaseResult =
  | ReleasedSessionWorkspace
  | MissingSessionWorkspaceRelease
  | FailedSessionWorkspaceRelease;

export interface SessionWorkspaceReleaseOptions {
  /**
   * Reset the live worker's in-memory session workspace before disk persistence.
   * Main passes AgentBridge.releaseWorkspace here for active-worker sessions.
   */
  releaseLiveWorkspace?: (sessionId: string) => Promise<void>;
}

let sessionManagerSingleton: SessionManager | undefined;
let sessionManagerHome: string | undefined;
let sessionManagerForTests: SessionManager | undefined;

export function __setSessionWorkspaceServiceSessionManagerForTests(
  sm: SessionManager | undefined,
): void {
  sessionManagerForTests = sm;
  sessionManagerSingleton = undefined;
  sessionManagerHome = undefined;
}

function sessions(): SessionManager {
  if (sessionManagerForTests) return sessionManagerForTests;
  const home = process.env.CODE_SHELL_HOME;
  if (!sessionManagerSingleton || sessionManagerHome !== home) {
    sessionManagerSingleton = new SessionManager();
    sessionManagerHome = home;
  }
  return sessionManagerSingleton;
}

function workspaceOwners(sm: SessionManager): WorktreeWorkspaceOwner[] {
  return sm.list(10_000).map((state) => ({
    sessionId: state.sessionId,
    workspace: state.workspace ?? { root: state.cwd, kind: "main" },
  }));
}

async function mainRootFor(sm: SessionManager, sessionId: string, cwd: string): Promise<string> {
  const fromSession = sm.readCwd(sessionId);
  if (fromSession) {
    const sessionRoot = await findMainWorktreeRootIfUsable(fromSession);
    if (sessionRoot) return fromSession;
  }
  if (!fromSession || resolve(cwd) !== resolve(fromSession)) {
    const cwdRoot = await findMainWorktreeRootIfUsable(cwd);
    if (cwdRoot) return cwdRoot;
  }
  return fromSession ?? cwd;
}

async function findMainWorktreeRootIfUsable(cwd: string): Promise<string | undefined> {
  try {
    return await findMainWorktreeRoot(cwd);
  } catch (err) {
    if (isNotGitRepositoryError(err)) return undefined;
    throw err;
  }
}

function isNotGitRepositoryError(err: unknown): boolean {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const output = (err as { output?: Array<Buffer | string | null> }).output;
  const message = [
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "",
    Array.isArray(output)
      ? output
          .map((part) =>
            typeof part === "string" ? part : Buffer.isBuffer(part) ? part.toString("utf-8") : "",
          )
          .join("\n")
      : "",
    err instanceof Error ? err.message : String(err),
  ].join("\n");
  return /not a git repository/i.test(message);
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

function missingReleaseReason(sm: SessionManager, sessionId: string): string | undefined {
  if (!sm.exists(sessionId)) return `unknown session: ${sessionId}`;
  if (sm.readCwd(sessionId) === undefined) {
    return "session exists but has no valid state — workspace release is a no-op";
  }
  return undefined;
}

function releaseError(sessionId: string, err: unknown): FailedSessionWorkspaceRelease {
  return {
    sessionId,
    ok: false,
    status: "error",
    error: err instanceof Error ? err.message : String(err),
  };
}

export async function getSessionWorkspaceForUi(
  sessionId: string,
  cwd: string,
): Promise<SessionWorkspace> {
  const sm = sessions();
  const mainRoot = await mainRootFor(sm, sessionId, cwd);
  return currentWorkspaceFor(sm, sessionId, mainRoot);
}

export async function listSessionWorktreesForUi(
  sessionId: string,
  cwd: string,
): Promise<SessionWorkspaceList> {
  const sm = sessions();
  const mainRoot = await mainRootFor(sm, sessionId, cwd);
  const current = currentWorkspaceFor(sm, sessionId, mainRoot);
  const prefix = worktreeBranchPrefix(mainRoot);
  return {
    current,
    mainRoot,
    worktrees: await listWorktreesFast(mainRoot, {
      currentSessionId: sessionId,
      workspaceOwners: workspaceOwners(sm),
      prefix,
    }),
  };
}

export async function getSessionWorktreeDiffForUi(
  sessionId: string,
  worktreePath: string,
): Promise<WorktreeDiffSummary> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const current = sm.getSessionWorkspace(sessionId);
  const baseRef =
    current?.kind === "worktree" && resolve(current.root) === resolve(worktreePath)
      ? current.worktree?.baseRef
      : undefined;
  return await getWorktreeDiff(worktreePath, baseRef);
}

export async function switchSessionWorkspaceForUi(
  sessionId: string,
  cwd: string,
  target: string,
): Promise<SessionWorkspaceList> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const trimmed = target.trim();
  if (!trimmed) throw new Error("target is required");
  const mainRoot = await mainRootFor(sm, sessionId, cwd);
  const from = currentWorkspaceFor(sm, sessionId, mainRoot);

  let next: SessionWorkspace;
  if (trimmed === "main") {
    next = { root: mainRoot, kind: "main" };
  } else {
    const prefix = worktreeBranchPrefix(mainRoot);
    const entries = await listWorktreesFast(mainRoot, { prefix });
    const pathTarget = pathLike(trimmed) ? resolvePathTarget(trimmed, from.root) : undefined;
    const branchTarget = normalizeBranchName(trimmed);
    const match = entries.find((entry) => {
      if (pathTarget && resolve(entry.path) === pathTarget) return true;
      return entry.branch === branchTarget;
    });

    if (match) {
      next = await worktreeWorkspaceFromEntry(match, from, mainRoot);
    } else {
      if (pathTarget) throw new Error(`no existing worktree found at ${trimmed}`);
      validateWorktreeSlug(trimmed);
      const created = await createWorktree(mainRoot, trimmed, sessionId, { prefix });
      next = {
        root: created.worktreePath,
        kind: "worktree",
        worktree: {
          path: created.worktreePath,
          branch: created.worktreeBranch,
          baseRef: created.originalBranch ?? (await currentBranch(mainRoot)) ?? "HEAD",
          createdBy: "codeshell",
        },
      };
    }
  }

  sm.setSessionWorkspace(sessionId, next);
  sm.recordWorkspaceHandoff(sessionId, from, next);
  return await listSessionWorktreesForUi(sessionId, mainRoot);
}

export async function releaseSessionWorkspaceForUi(
  sessionId: string,
  opts: SessionWorkspaceReleaseOptions = {},
): Promise<SessionWorkspaceReleaseResult> {
  const sm = sessions();
  if (opts.releaseLiveWorkspace) {
    try {
      await opts.releaseLiveWorkspace(sessionId);
    } catch (err) {
      return releaseError(sessionId, err);
    }
  }
  const missing = missingReleaseReason(sm, sessionId);
  if (missing) {
    return { sessionId, ok: true, status: "missing", reason: missing };
  }
  try {
    const sessionCwd = sm.readCwd(sessionId);
    const mainRoot = await mainRootFor(sm, sessionId, sessionCwd ?? process.cwd());
    const from = currentWorkspaceFor(sm, sessionId, mainRoot);
    const next: SessionWorkspace = { root: mainRoot, kind: "main" };
    if (from.kind === "main" && resolve(from.root) === resolve(mainRoot)) {
      return { sessionId, ok: true, status: "released", workspace: next };
    }
    sm.setSessionWorkspace(sessionId, next);
    sm.recordWorkspaceHandoff(sessionId, from, next);
    return { sessionId, ok: true, status: "released", workspace: next };
  } catch (err) {
    return releaseError(sessionId, err);
  }
}

export async function releaseManySessionWorkspacesForUi(
  sessionIds: string[],
  opts: SessionWorkspaceReleaseOptions = {},
): Promise<SessionWorkspaceReleaseResult[]> {
  const unique = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.length > 0))];
  const released: SessionWorkspaceReleaseResult[] = [];
  for (const sessionId of unique) {
    released.push(await releaseSessionWorkspaceForUi(sessionId, opts));
  }
  return released;
}

export async function cleanupSessionWorktreeForUi(
  sessionId: string,
  cwd: string,
  worktreePath: string,
  action: WorkspaceCleanupAction,
): Promise<SessionWorkspaceList> {
  if (action !== "detach" && action !== "discard") {
    throw new Error("action must be detach or discard");
  }
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const mainRoot = await mainRootFor(sm, sessionId, cwd);
  const prefix = worktreeBranchPrefix(mainRoot);
  const current = currentWorkspaceFor(sm, sessionId, mainRoot);
  const entries = await listWorktreesFast(mainRoot, {
    currentSessionId: sessionId,
    workspaceOwners: workspaceOwners(sm),
    prefix,
  });
  const match = entries.find((entry) => resolve(entry.path) === resolve(worktreePath));
  if (!match) throw new Error(`worktree not found: ${worktreePath}`);
  if (resolve(match.path) === resolve(mainRoot))
    throw new Error("cannot clean up the main workspace");
  if (!match.isManaged) {
    throw new Error("cannot clean up an external worktree; remove it manually");
  }
  if (match.occupiedByOtherSession) {
    throw new Error("worktree is occupied by another session");
  }

  const baseRef =
    current.kind === "worktree" && resolve(current.root) === resolve(match.path)
      ? current.worktree?.baseRef
      : undefined;
  const dirty = await worktreeHasUncommittedOrAheadChanges(match.path, baseRef);
  if (action === "detach" && dirty) {
    throw new Error(
      "detach would drop uncommitted changes or new commits. Choose discard to delete the worktree and branch.",
    );
  }

  // A discard can remove the directory but leave branch deletion for manual
  // cleanup. That still returns normally so the active session pointer below
  // moves back to main instead of staying on a removed directory.
  removeWorktree(match.path, action === "discard", { prefix });
  if (current.kind === "worktree" && resolve(current.root) === resolve(match.path)) {
    const mainWorkspace: SessionWorkspace = { root: mainRoot, kind: "main" };
    sm.setSessionWorkspace(sessionId, mainWorkspace);
    sm.recordWorkspaceHandoff(sessionId, current, mainWorkspace);
  }
  return await listSessionWorktreesForUi(sessionId, mainRoot);
}

async function worktreeWorkspaceFromEntry(
  entry: WorktreeInfo,
  current: SessionWorkspace,
  mainRoot: string,
): Promise<SessionWorkspace> {
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
      baseRef: previous?.baseRef ?? (await currentBranch(mainRoot)) ?? "HEAD",
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

function worktreeBranchPrefix(cwd: string): string | undefined {
  try {
    const settings = new SettingsManager(cwd, "full").get() as {
      worktree?: { branchPrefix?: string };
    };
    return settings.worktree?.branchPrefix;
  } catch {
    return undefined;
  }
}
