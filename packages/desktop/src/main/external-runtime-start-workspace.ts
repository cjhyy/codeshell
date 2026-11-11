import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { assertDesktopSessionId } from "./session-validation.js";
import {
  getSessionWorkspaceAuthorityForUi,
  requireUsableSessionRootAuthority,
} from "./session-workspace-service.js";

/** Renderer cwd identifies the Session's project; the Session owns its execution workspace. */
export async function resolveExternalRuntimeStartWorkspace(
  sessionId: string,
  requestedCwd: unknown,
  dependencies: {
    sessions?: SessionManager;
    sessionAuthority?: typeof getSessionWorkspaceAuthorityForUi;
    projectPath?: typeof requireRendererProjectPath;
  } = {},
): Promise<{ cwd: string; mainRoot: string; assertStartAuthority: () => void }> {
  assertDesktopSessionId(sessionId);
  const sessions = dependencies.sessions ?? new SessionManager();
  const requireProjectPath = dependencies.projectPath ?? requireRendererProjectPath;
  const existed = sessions.exists(sessionId);
  let cwd: string;
  let mainRoot: string;
  let project: { projectId: string; mainRootId: string } | undefined;
  if (existed) {
    const authority = await (dependencies.sessionAuthority ?? getSessionWorkspaceAuthorityForUi)(
      sessionId,
    );
    requireUsableSessionRootAuthority(authority);
    mainRoot = await requireProjectPath(authority.mainRoot);
    cwd = await externalRuntimeStartDirectory(authority.workspace.root);
    const hint = await externalRuntimeStartDirectory(requestedCwd);
    if (canonicalKey(hint) !== canonicalKey(mainRoot) && canonicalKey(hint) !== canonicalKey(cwd)) {
      throw new Error("requested cwd does not match persisted Session workspace");
    }
    if (authority.projectId && authority.mainRootId) {
      project = { projectId: authority.projectId, mainRootId: authority.mainRootId };
    }
  } else {
    cwd = mainRoot = await requireProjectPath(requestedCwd);
  }
  const assertStartAuthority = () => {
    if (!sessions.exists(sessionId)) {
      if (existed) throw new Error("External runtime Session changed before startup");
      return;
    }
    const currentMainRoot = sessions.readSessionMainRoot(sessionId);
    const currentWorkspace = sessions.getSessionWorkspace(sessionId);
    const currentProject = sessions.readSessionProjectBinding(sessionId);
    if (
      !currentMainRoot ||
      !currentWorkspace ||
      canonicalKey(currentMainRoot) !== canonicalKey(mainRoot) ||
      canonicalKey(currentWorkspace.root) !== canonicalKey(cwd) ||
      (project &&
        (currentProject?.projectId !== project.projectId ||
          currentProject?.mainRootId !== project.mainRootId))
    ) {
      throw new Error(
        "External runtime Session workspace changed before startup; retry the request",
      );
    }
  };
  assertStartAuthority();
  return { cwd, mainRoot, assertStartAuthority };
}

async function externalRuntimeStartDirectory(input: unknown): Promise<string> {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 32_768 ||
    input.includes("\0") ||
    !isAbsolute(input)
  ) {
    throw new Error("external runtime cwd must be an existing absolute directory");
  }
  const directory = await realpath(input);
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("external runtime cwd must be an existing absolute directory");
  }
  return directory;
}
