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
  if (
    !getProjectStore().isNoRepoCwd(authority.mainRoot) &&
    !getProjectStore().resolveExactRootSync(authority.mainRoot)
  )
    throw new Error("Session root is not mounted");
  const root = lstatSync(authority.mainRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("invalid project root");
  const stamp = JSON.stringify([
    directory.dev,
    directory.ino,
    state.startedAt,
    authority.projectId,
    authority.mainRootId,
    authority.mainRoot,
    root.dev,
    root.ino,
    authority.workspace.root,
  ]);
  const sessionAuthority = JSON.stringify([
    state.startedAt,
    state.cwd,
    state.project,
    manager.getSessionWorkspace(sessionId),
  ]);
  const assertCurrent = () => {
    const now = manager.readSessionState(sessionId);
    const session = lstatSync(join(sessionsRoot(), sessionId));
    const currentRoot = lstatSync(authority.mainRoot);
    const mounted = getProjectStore().isNoRepoCwd(authority.mainRoot)
      ? undefined
      : getProjectStore().resolveExactRootSync(authority.mainRoot);
    if (
      !now ||
      now.outputRecoveryIncomplete ||
      !session.isDirectory() ||
      session.isSymbolicLink() ||
      session.dev !== directory.dev ||
      session.ino !== directory.ino ||
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink() ||
      currentRoot.dev !== root.dev ||
      currentRoot.ino !== root.ino ||
      JSON.stringify([
        now.startedAt,
        now.cwd,
        now.project,
        manager.getSessionWorkspace(sessionId),
      ]) !== sessionAuthority ||
      (!getProjectStore().isNoRepoCwd(authority.mainRoot) &&
        (!mounted ||
          mounted.project.id !== authority.projectId ||
          mounted.mainRoot.id !== authority.mainRootId))
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
