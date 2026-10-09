import { lstatSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { getProjectStore } from "../project-store.js";
import { assertDesktopSessionId } from "../session-validation.js";
import { getSessionWorkspaceAuthorityForUi } from "../session-workspace-service.js";

/** Re-resolve mounted project authority for every page; no worker or runtime is started. */
export async function mobileOutputRecoveryAuthority(sessionId: string): Promise<string> {
  assertDesktopSessionId(sessionId);
  const directory = lstatSync(join(sessionsRoot(), sessionId));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("invalid Session");
  const state = new SessionManager().readSessionState(sessionId);
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
  return JSON.stringify([
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
}
