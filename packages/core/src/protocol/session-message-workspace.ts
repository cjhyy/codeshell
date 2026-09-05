import type { SessionManager } from "../session/session-manager.js";
import { canonicalKey } from "../workspace/canonical-key.js";
import {
  createWorkspaceContext,
  validateWorkspaceContext,
  type WorkspaceContext,
} from "../workspace/workspace-context.js";

export interface SessionMessageWorkspace {
  cwd: string;
  workspaceContext?: WorkspaceContext;
  projectTrusted?: boolean;
}

/**
 * Protocol-only hosts can reuse already trusted mounted roots. Desktop should
 * ask its project registry for fresh authority instead. Persisted Session ids,
 * bindings and runtime roots always take precedence over a caller's catalog.
 */
export function resolveSessionMessageWorkspace(input: {
  sessionManager: Pick<
    SessionManager,
    "readSessionMainRoot" | "readSessionProjectBinding" | "getSessionWorkspace"
  >;
  sourceSessionId: string;
  targetSessionId: string;
  sourceWorkspace: SessionMessageWorkspace;
  targetWorkspace?: SessionMessageWorkspace;
}): SessionMessageWorkspace & { projectTrusted: boolean } {
  const { sessionManager, sourceSessionId, targetSessionId, sourceWorkspace, targetWorkspace } =
    input;
  const sourceMain = sessionManager.readSessionMainRoot(sourceSessionId) ?? sourceWorkspace.cwd;
  const targetMain = sessionManager.readSessionMainRoot(targetSessionId);
  const sourceBinding = sessionManager.readSessionProjectBinding(sourceSessionId);
  const targetBinding = sessionManager.readSessionProjectBinding(targetSessionId);
  const cwd = sessionManager.getSessionWorkspace(targetSessionId)?.root ?? targetMain ?? sourceMain;
  const sameMainRoot = !targetMain || canonicalKey(sourceMain) === canonicalKey(targetMain);
  const projectTrusted =
    targetWorkspace?.projectTrusted ?? (sameMainRoot && sourceWorkspace.projectTrusted === true);

  if (targetMain && !targetBinding) {
    if (!sameMainRoot)
      throw new Error("target Session does not share the source's authorized main root");
    return { cwd, projectTrusted };
  }
  if (!targetBinding && !sourceBinding) return { cwd, projectTrusted };
  if (targetBinding && (!sourceBinding || targetBinding.projectId !== sourceBinding.projectId)) {
    throw new Error("target Session project binding is not authorized by the source Session");
  }
  const binding = targetBinding ?? sourceBinding!;
  if (!sourceWorkspace.workspaceContext) {
    throw new Error("cross-Session run requires an authoritative WorkspaceContext from the host");
  }
  const context = validateWorkspaceContext(sourceWorkspace.workspaceContext);
  if (
    context.projectId !== sourceBinding?.projectId ||
    context.sessionMainRootId !== sourceBinding.mainRootId
  ) {
    throw new Error("source WorkspaceContext does not match its persisted project binding");
  }
  // A source worktree is a runtime substitution, not a project mount that may
  // be propagated into another Session's secondary roots.
  const mountedRoots = context.roots.map((root) =>
    root.id === sourceBinding.mainRootId ? { ...root, path: sourceMain } : { ...root },
  );
  const targetRoot = mountedRoots.find((root) => root.id === binding.mainRootId);
  if (!targetRoot || (targetMain && canonicalKey(targetRoot.path) !== canonicalKey(targetMain))) {
    throw new Error("target Session main root is not present in the host-authorized project roots");
  }
  return {
    cwd,
    projectTrusted,
    workspaceContext: createWorkspaceContext({
      projectId: context.projectId,
      projectRevision: context.projectRevision,
      sessionMainRootId: binding.mainRootId,
      roots: mountedRoots.map((root) => ({
        ...root,
        path: root.id === binding.mainRootId ? cwd : root.path,
        role: root.id === binding.mainRootId ? "primary" : "secondary",
      })),
    }),
  };
}
