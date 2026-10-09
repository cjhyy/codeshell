import { lstatSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { getProjectStore } from "../project-store.js";
import { assertDesktopSessionId } from "../session-validation.js";
import { getSessionWorkspaceAuthorityForUi } from "../session-workspace-service.js";

/** Re-resolve mounted project authority for every page; no worker or runtime is started. */
export async function mobileSessionCommandAuthority(sessionId: string) {
  assertDesktopSessionId(sessionId);
  const directory = lstatSync(join(sessionsRoot(), sessionId));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("invalid Session");
  const manager = new SessionManager();
  const state = manager.readSessionState(sessionId);
  if (
    !state ||
    state.ephemeral ||
    state.parentSessionId ||
    state.kind === "pet" ||
    state.outputRecoveryIncomplete
  )
    throw new Error("Session recovery unavailable");
  const authority = await getSessionWorkspaceAuthorityForUi(sessionId);
  if (authority.rootStatus !== "ok") throw new Error("Session project unavailable");
  // Bind the state resolved after asynchronous project probes, while rejecting
  // Session replacement across the await.
  const boundState = manager.readSessionState(sessionId);
  const boundDirectory = lstatSync(join(sessionsRoot(), sessionId));
  const workspace = manager.getSessionWorkspace(sessionId);
  if (
    !boundState ||
    boundState.startedAt !== state.startedAt ||
    JSON.stringify([boundState.cwd, boundState.project, boundState.workspace]) !==
      JSON.stringify([state.cwd, state.project, state.workspace]) ||
    boundState.ephemeral ||
    boundState.parentSessionId ||
    boundState.kind === "pet" ||
    boundState.outputRecoveryIncomplete ||
    !boundDirectory.isDirectory() ||
    boundDirectory.isSymbolicLink() ||
    boundDirectory.dev !== directory.dev ||
    boundDirectory.ino !== directory.ino ||
    JSON.stringify(workspace) !== JSON.stringify(authority.workspace) ||
    (workspace?.kind === "worktree" && workspace.worktree?.path !== workspace.root)
  )
    throw new Error("Session command authority changed");
  const noRepo = getProjectStore().isNoRepoCwd(authority.mainRoot);
  const registered = noRepo
    ? undefined
    : getProjectStore().resolveExactRootSync(authority.mainRoot);
  if (!noRepo && !registered) throw new Error("Session root is not mounted");
  if (
    registered &&
    authority.projectId &&
    (registered.project.id !== authority.projectId ||
      registered.mainRoot.id !== authority.mainRootId)
  )
    throw new Error("Session command authority changed");
  const root = lstatSync(authority.mainRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("invalid project root");
  const executionRoot = lstatSync(authority.workspace.root);
  if (!executionRoot.isDirectory() || executionRoot.isSymbolicLink())
    throw new Error("invalid workspace root");
  // Main roots may retain /tmp versus /private/tmp spelling on macOS.
  if (
    workspace?.kind === "main" &&
    (executionRoot.dev !== root.dev || executionRoot.ino !== root.ino)
  )
    throw new Error("Session command authority changed");
  const stamp = JSON.stringify([
    directory.dev,
    directory.ino,
    state.startedAt,
    authority.projectId,
    authority.mainRootId,
    authority.mainRoot,
    root.dev,
    root.ino,
    authority.workspace,
    executionRoot.dev,
    executionRoot.ino,
    registered?.project.id,
    registered?.mainRoot.id,
  ]);
  const sessionAuthority = JSON.stringify([
    boundState.startedAt,
    boundState.cwd,
    boundState.project,
    boundState.workspace,
    workspace,
  ]);
  const assertCurrent = () => {
    const now = manager.readSessionState(sessionId);
    const session = lstatSync(join(sessionsRoot(), sessionId));
    const currentRoot = lstatSync(authority.mainRoot);
    const currentExecutionRoot = lstatSync(authority.workspace.root);
    const mounted = getProjectStore().isNoRepoCwd(authority.mainRoot)
      ? undefined
      : getProjectStore().resolveExactRootSync(authority.mainRoot);
    if (
      !now ||
      now.ephemeral ||
      now.parentSessionId ||
      now.kind === "pet" ||
      now.outputRecoveryIncomplete ||
      !session.isDirectory() ||
      session.isSymbolicLink() ||
      session.dev !== directory.dev ||
      session.ino !== directory.ino ||
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink() ||
      currentRoot.dev !== root.dev ||
      currentRoot.ino !== root.ino ||
      !currentExecutionRoot.isDirectory() ||
      currentExecutionRoot.isSymbolicLink() ||
      currentExecutionRoot.dev !== executionRoot.dev ||
      currentExecutionRoot.ino !== executionRoot.ino ||
      JSON.stringify([
        now.startedAt,
        now.cwd,
        now.project,
        now.workspace,
        manager.getSessionWorkspace(sessionId),
      ]) !== sessionAuthority ||
      getProjectStore().isNoRepoCwd(authority.mainRoot) !== noRepo ||
      (!noRepo &&
        (!mounted ||
          mounted.project.id !== registered?.project.id ||
          mounted.mainRoot.id !== registered?.mainRoot.id))
    )
      throw new Error("Session command authority changed");
  };
  assertCurrent();
  return {
    assertCurrent,
    stamp,
    cwd: authority.workspace.root,
    projectId: authority.projectId,
    rootId: authority.mainRootId,
  };
}

export async function mobileOutputRecoveryAuthority(sessionId: string): Promise<string> {
  return (await mobileSessionCommandAuthority(sessionId)).stamp;
}
