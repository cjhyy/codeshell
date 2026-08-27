import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createWorkspaceContext,
  SessionManager,
  SettingsManager,
  type SessionWorkspace,
} from "@cjhyy/code-shell-core";
import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import {
  createWorktree,
  currentBranch,
  findMainWorktreeRoot,
  getWorktreeDiff,
  listWorktreesFast,
  removeWorktree,
  validateWorktreeSlug,
  worktreeHasUncommittedOrAheadChanges,
  type WorktreeDiffSummary,
  type WorktreeInfo,
  type WorktreeWorkspaceOwner,
} from "@cjhyy/code-shell-capability-coding/git";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { getProjectStore, type ProjectStore } from "./project-store.js";
import { requireMountedProjectRoot, validateMountedProjectRoot } from "./mounted-project-root.js";

export type WorkspaceCleanupAction = "detach" | "discard";

export interface SessionWorkspaceList {
  current: SessionWorkspace;
  mainRoot: string;
  worktrees: WorktreeInfo[];
}

export type SessionRootStatus = "ok" | "dir_missing" | "root_removed" | "root_replaced";
export type SessionRootStatusReason =
  | "directory_missing"
  | "project_missing"
  | "root_not_mounted"
  | "identity_mismatch";

export interface SessionWorkspaceAuthority {
  workspace: SessionWorkspace;
  projectId: string | null;
  mainRootId: string | null;
  mainRoot: string;
  mainRootName: string;
  rootStatus: SessionRootStatus;
  rootStatusReason?: SessionRootStatusReason;
  rootStatusMessage?: string;
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

export interface SessionWorkspaceMutationOptions {
  /** Persist through the live worker so its in-memory bundle adopts the revision. */
  setLiveWorkspace?: (sessionId: string, workspace: SessionWorkspace) => Promise<void>;
}

let sessionManagerSingleton: SessionManager | undefined;
let sessionManagerHome: string | undefined;
let sessionManagerForTests: SessionManager | undefined;
let projectStoreForTests: ProjectStore | undefined;

export function __setSessionWorkspaceServiceSessionManagerForTests(
  sm: SessionManager | undefined,
): void {
  sessionManagerForTests = sm;
  sessionManagerSingleton = undefined;
  sessionManagerHome = undefined;
}

export function __setSessionWorkspaceServiceProjectStoreForTests(
  store: ProjectStore | undefined,
): void {
  projectStoreForTests = store;
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

function projects(): ProjectStore {
  return projectStoreForTests ?? getProjectStore();
}

function workspaceOwners(sm: SessionManager): WorktreeWorkspaceOwner[] {
  return sm.list(10_000).map((state) => ({
    sessionId: state.sessionId,
    workspace: state.workspace ?? { root: state.cwd, kind: "main" },
  }));
}

async function mainRootFor(sm: SessionManager, sessionId: string): Promise<string> {
  const authority = await mainRootAuthorityFor(sm, sessionId);
  requireUsableSessionRootAuthority(authority);
  return authority.mainRoot;
}

async function mainRootAuthorityFor(
  sm: SessionManager,
  sessionId: string,
): Promise<Omit<SessionWorkspaceAuthority, "workspace">> {
  const fromSession = sm.readSessionMainRoot(sessionId);
  if (!fromSession) {
    throw new Error("session exists but has no valid state — cannot resolve workspace root");
  }
  // Probe Git usability, but preserve the persisted spelling. On macOS Git may
  // canonicalize /var to /private/var; rewriting that into Session state breaks
  // stable workspace identity and creates a spurious handoff.
  const binding = sm.readSessionProjectBinding(sessionId);
  if (binding) {
    const project = await projects().get(binding.projectId);
    if (!project || project.deletedAt !== undefined) {
      return {
        projectId: binding.projectId,
        mainRootId: binding.mainRootId,
        mainRoot: fromSession,
        mainRootName: rootName(fromSession),
        rootStatus: "root_removed",
        rootStatusReason: "project_missing",
        rootStatusMessage: `Session root status root_removed: project ${binding.projectId} is unavailable`,
      };
    }
    const root = project.roots.find((candidate) => candidate.id === binding.mainRootId);
    if (!root) {
      return {
        projectId: binding.projectId,
        mainRootId: binding.mainRootId,
        mainRoot: fromSession,
        mainRootName: rootName(fromSession),
        rootStatus: "root_removed",
        rootStatusReason: "root_not_mounted",
        rootStatusMessage:
          `Session root status root_removed: root ${binding.mainRootId} ` +
          `is no longer mounted in project ${binding.projectId}`,
      };
    }
    const validation = validateMountedProjectRoot(root);
    if (validation.status !== "ok") {
      return {
        projectId: binding.projectId,
        mainRootId: root.id,
        mainRoot: root.path,
        mainRootName: root.name,
        rootStatus: validation.status,
        rootStatusReason: validation.reason,
        rootStatusMessage: `Session root status ${validation.status}: ${validation.message}`,
      };
    }
    await findMainWorktreeRootIfUsable(root.path);
    return {
      projectId: binding.projectId,
      mainRootId: root.id,
      mainRoot: root.path,
      mainRootName: root.name,
      rootStatus: "ok",
    };
  }
  const registeredValidation = projects().validateRegisteredRootPathSync(fromSession);
  if (registeredValidation && registeredValidation.status !== "ok") {
    return {
      projectId: null,
      mainRootId: null,
      mainRoot: fromSession,
      mainRootName: rootName(fromSession),
      rootStatus: registeredValidation.status,
      rootStatusReason: registeredValidation.reason,
      rootStatusMessage:
        `Session root status ${registeredValidation.status}: ` +
        (registeredValidation.message ?? "registered root identity changed"),
    };
  }
  if (!isDirectory(fromSession)) {
    return {
      projectId: null,
      mainRootId: null,
      mainRoot: fromSession,
      mainRootName: rootName(fromSession),
      rootStatus: "dir_missing",
      rootStatusReason: "directory_missing",
      rootStatusMessage: `Session root status dir_missing: directory is missing: ${fromSession}`,
    };
  }
  await findMainWorktreeRootIfUsable(fromSession);
  return {
    projectId: null,
    mainRootId: null,
    mainRoot: fromSession,
    mainRootName: rootName(fromSession),
    rootStatus: "ok",
  };
}

function rootName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function requireUsableSessionRootAuthority(
  authority: Pick<SessionWorkspaceAuthority, "rootStatus" | "rootStatusMessage">,
): void {
  if (authority.rootStatus !== "ok") {
    throw new Error(
      authority.rootStatusMessage ?? `Session root status ${authority.rootStatus}: repair required`,
    );
  }
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
  if (sm.readSessionMainRoot(sessionId) === undefined) {
    throw new Error("session exists but has no valid state — cannot perform workspace operations");
  }
}

function missingReleaseReason(sm: SessionManager, sessionId: string): string | undefined {
  if (!sm.exists(sessionId)) return `unknown session: ${sessionId}`;
  if (sm.readSessionMainRoot(sessionId) === undefined) {
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
  _cwd: string,
): Promise<SessionWorkspace> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const mainRoot = await mainRootFor(sm, sessionId);
  return currentWorkspaceFor(sm, sessionId, mainRoot);
}

export async function getSessionWorkspaceAuthorityForUi(
  sessionId: string,
): Promise<SessionWorkspaceAuthority> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const authority = await mainRootAuthorityFor(sm, sessionId);
  return {
    workspace: currentWorkspaceFor(sm, sessionId, authority.mainRoot),
    ...authority,
  };
}

/**
 * Main-owned Review entry point. Project-bound Sessions are expanded through
 * their persisted binding and current WorkspaceContext; legacy Sessions keep a
 * deterministic single-root identity. No renderer-supplied root participates.
 */
export async function resolveSessionReviewWorkspaceForUi(sessionId: string): Promise<{
  projectId: string | null;
  mainRootId: string;
  roots: Array<{ id: string; path: string; role: "primary" | "secondary" }>;
}> {
  const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
  requireUsableSessionRootAuthority(authority);
  if (authority.projectId && authority.mainRootId) {
    const project = await projects().requireLive(authority.projectId);
    const mountedPaths = new Map(
      project.roots.map((root) => [root.id, requireMountedProjectRoot(root)] as const),
    );
    const context = createWorkspaceContext({
      projectId: project.id,
      projectRevision: project.revision,
      sessionMainRootId: authority.mainRootId,
      roots: project.roots.map((root) => ({
        id: root.id,
        path:
          root.id === authority.mainRootId ? authority.workspace.root : mountedPaths.get(root.id)!,
        role: root.id === authority.mainRootId ? "primary" : "secondary",
      })),
    });
    return {
      projectId: context.projectId,
      mainRootId: context.sessionMainRootId,
      roots: context.roots,
    };
  }

  const rootId = `legacy:${sessionId}`;
  return {
    projectId: null,
    mainRootId: rootId,
    roots: [{ id: rootId, path: authority.workspace.root, role: "primary" }],
  };
}

export async function requireSessionFileRootForUi(
  sessionId: string,
  rootId: string,
): Promise<string> {
  if (typeof rootId !== "string" || !rootId) throw new Error("session file root id is required");
  const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
  requireUsableSessionRootAuthority(authority);
  if (!authority.projectId || !authority.mainRootId) {
    throw new Error("session is not bound to a project root");
  }
  if (rootId === authority.mainRootId) {
    const current = authority.workspace;
    if (current.kind === "main") {
      if (canonicalKey(current.root) !== canonicalKey(authority.mainRoot)) {
        throw new Error("session main workspace does not match its authoritative root");
      }
      return current.root;
    }
    if (
      current.worktree?.createdBy !== "codeshell" ||
      canonicalKey(current.worktree.path) !== canonicalKey(current.root)
    ) {
      throw new Error("session workspace is not an authorized worktree");
    }
    const entries = await listWorktreesFast(authority.mainRoot, {
      prefix: worktreeBranchPrefix(authority.mainRoot),
    });
    if (!entries.some((entry) => canonicalKey(entry.path) === canonicalKey(current.root))) {
      throw new Error("session workspace is not an authorized worktree");
    }
    return current.root;
  }
  const project = await projects().requireLive(authority.projectId);
  const root = project.roots.find((candidate) => candidate.id === rootId);
  if (!root) throw new Error("session project root not found");
  return requireMountedProjectRoot(root);
}

export async function listSessionWorktreesForUi(
  sessionId: string,
  _cwd: string,
): Promise<SessionWorkspaceList> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const mainRoot = await mainRootFor(sm, sessionId);
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
  const mainRoot = await mainRootFor(sm, sessionId);
  const entries = await listWorktreesFast(mainRoot, { prefix: worktreeBranchPrefix(mainRoot) });
  if (!entries.some((entry) => resolve(entry.path) === resolve(worktreePath))) {
    throw new Error(`worktree is outside the session repository: ${worktreePath}`);
  }
  const current = sm.getSessionWorkspace(sessionId);
  const baseRef =
    current?.kind === "worktree" && resolve(current.root) === resolve(worktreePath)
      ? current.worktree?.baseRef
      : undefined;
  return await getWorktreeDiff(worktreePath, baseRef);
}

export async function switchSessionWorkspaceForUi(
  sessionId: string,
  _cwd: string,
  target: string,
  opts: SessionWorkspaceMutationOptions = {},
): Promise<SessionWorkspaceList> {
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const trimmed = target.trim();
  if (!trimmed) throw new Error("target is required");
  const mainRoot = await mainRootFor(sm, sessionId);
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

  if (opts.setLiveWorkspace) await opts.setLiveWorkspace(sessionId, next);
  else sm.setSessionWorkspace(sessionId, next);
  getSessionCwdIndex().setWorkspaceRoot(sessionId, next.root);
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
    const mainRoot = await mainRootFor(sm, sessionId);
    const from = currentWorkspaceFor(sm, sessionId, mainRoot);
    const next: SessionWorkspace = { root: mainRoot, kind: "main" };
    if (from.kind === "main" && resolve(from.root) === resolve(mainRoot)) {
      getSessionCwdIndex().setWorkspaceRoot(sessionId, next.root);
      return { sessionId, ok: true, status: "released", workspace: next };
    }
    sm.setSessionWorkspace(sessionId, next);
    getSessionCwdIndex().setWorkspaceRoot(sessionId, next.root);
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
  _cwd: string,
  worktreePath: string,
  action: WorkspaceCleanupAction,
  opts: SessionWorkspaceMutationOptions = {},
): Promise<SessionWorkspaceList> {
  if (action !== "detach" && action !== "discard") {
    throw new Error("action must be detach or discard");
  }
  const sm = sessions();
  requireKnownSession(sm, sessionId);
  const mainRoot = await mainRootFor(sm, sessionId);
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

  // Rebase the live owner before deleting its cwd. A discard can remove the
  // directory but leave branch deletion for manual cleanup; either way the
  // session already points at main and cannot later persist the removed root.
  if (current.kind === "worktree" && resolve(current.root) === resolve(match.path)) {
    const mainWorkspace: SessionWorkspace = { root: mainRoot, kind: "main" };
    if (opts.setLiveWorkspace) await opts.setLiveWorkspace(sessionId, mainWorkspace);
    else sm.setSessionWorkspace(sessionId, mainWorkspace);
    getSessionCwdIndex().setWorkspaceRoot(sessionId, mainWorkspace.root);
    sm.recordWorkspaceHandoff(sessionId, current, mainWorkspace);
  }
  removeWorktree(match.path, action === "discard", { prefix });
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
