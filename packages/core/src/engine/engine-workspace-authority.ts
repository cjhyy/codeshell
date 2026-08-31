import type { SessionProjectBinding, SessionState, SessionWorkspace } from "../types.js";
import { assertSafeSessionId, type SessionManager } from "../session/session-manager.js";
import type {
  SessionMessageRouter,
  SessionMessageTarget,
  SessionMessageToolService,
} from "../session/session-message.js";
import { clearSessionPathApprovalsUnderRoot } from "../tool-system/path-policy.js";
import { canonicalKey } from "../workspace/canonical-key.js";
import {
  rebaseWorkspacePrimaryRoot,
  removedWorkspaceRootPaths,
  type WorkspaceContext,
} from "../workspace/workspace-context.js";

export interface SyntheticRunWorkspace {
  cwd: string;
  workspaceContext?: WorkspaceContext;
}

export class SessionWorkspaceAuthorityTracker {
  private readonly contexts = new Map<string, WorkspaceContext>();

  remember(sessionId: string, context: WorkspaceContext): void {
    const previous = this.contexts.get(sessionId);
    if (previous) {
      for (const root of removedWorkspaceRootPaths(previous, context)) {
        clearSessionPathApprovalsUnderRoot(sessionId, root);
      }
    }
    this.contexts.set(sessionId, context);
  }

  get(sessionId: string): WorkspaceContext | undefined {
    return this.contexts.get(sessionId);
  }

  delete(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  clear(): void {
    this.contexts.clear();
  }
}

/**
 * Reconstruct authoritative options for a core-originated continuation.
 * Interactive turns carry a fresh WorkspaceContext from their host, whereas
 * background-result wakeups must rebase the last trusted context onto the
 * SessionWorkspace persisted after a worktree switch.
 */
export function resolveSyntheticRunWorkspace(
  sessionManager: SessionManager,
  authorities: SessionWorkspaceAuthorityTracker,
  config: { cwd?: string; workspaceContext?: WorkspaceContext },
  sessionId: string,
): SyntheticRunWorkspace {
  const workspace = sessionManager.getSessionWorkspace(sessionId);
  const cwd =
    workspace?.root ?? sessionManager.readSessionMainRoot(sessionId) ?? config.cwd ?? process.cwd();
  const binding = sessionManager.readSessionProjectBinding(sessionId);
  const baseContext = authorities.get(sessionId) ?? config.workspaceContext;

  // A legacy Session with no host authority must stay legacy. Passing a
  // synthesized prior-run context would persist a spurious project binding.
  if (!binding && !config.workspaceContext) return { cwd };
  if (!baseContext) {
    throw new Error(`Session ${sessionId} has a project binding but no WorkspaceContext`);
  }
  if (
    binding &&
    (binding.projectId !== baseContext.projectId ||
      binding.mainRootId !== baseContext.sessionMainRootId)
  ) {
    throw new Error(`Session ${sessionId} WorkspaceContext does not match its project binding`);
  }
  return {
    cwd,
    workspaceContext: rebaseWorkspacePrimaryRoot(baseContext, cwd),
  };
}

export function createAuthorizedSessionMessageService(options: {
  sessionManager: SessionManager;
  router: SessionMessageRouter | undefined;
  sourceSessionId: string;
  rawTargets: unknown;
}): SessionMessageToolService | undefined {
  const { sessionManager, router, sourceSessionId } = options;
  const sourceRoot = sessionManager.readSessionMainRoot(sourceSessionId);
  if (!sourceRoot || !router) return undefined;
  const sourceBinding = sessionManager.readSessionProjectBinding(sourceSessionId);
  const catalog: SessionMessageTarget[] = [];
  const seen = new Set<string>();
  const rawTargets: unknown[] = Array.isArray(options.rawTargets) ? [...options.rawTargets] : [];
  for (const raw of rawTargets.slice(0, 100)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId : "";
    try {
      assertSafeSessionId(sessionId);
    } catch {
      continue;
    }
    if (seen.has(sessionId)) continue;
    const candidateRoot =
      typeof candidate.workspaceRoot === "string" ? candidate.workspaceRoot : "";
    const targetBinding = sessionManager.readSessionProjectBinding(sessionId);
    if (sourceBinding) {
      if (targetBinding) {
        if (targetBinding.projectId !== sourceBinding.projectId) continue;
      } else if (canonicalKey(candidateRoot) !== canonicalKey(sourceRoot)) {
        continue;
      }
    } else if (canonicalKey(candidateRoot) !== canonicalKey(sourceRoot)) {
      continue;
    }
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!title || title.length > 512) continue;
    const workspaceProfile =
      typeof candidate.workspaceProfile === "string"
        ? candidate.workspaceProfile.trim().slice(0, 256)
        : "";
    seen.add(sessionId);
    catalog.push({
      sessionId,
      title,
      workspaceRoot: sourceRoot,
      ...(workspaceProfile ? { workspaceProfile } : {}),
    });
  }

  const targets = catalog.filter((target) => target.sessionId !== sourceSessionId);
  return {
    targets,
    send: async ({ targetSessionId, message }) => {
      const target = targets.find((candidate) => candidate.sessionId === targetSessionId);
      if (!target) throw new Error("target Session is not in the host-authorized project list");
      if (!message.trim()) throw new Error("message is required");
      if (message.length > 48_000) throw new Error("message exceeds 48000 characters");
      await router({ sourceSessionId, target, message, catalog });
      return target;
    },
  };
}

export function migrateOwnedSessionMainRoot(options: {
  sessionManager: SessionManager;
  activeState?: SessionState;
  authorities: SessionWorkspaceAuthorityTracker;
  sessionId: string;
  project: SessionProjectBinding;
  mainRoot: string;
}): SessionWorkspace {
  const { sessionManager, activeState, authorities, sessionId, project, mainRoot } = options;
  if (!sessionId || !sessionManager.exists(sessionId)) {
    throw new Error(`Session ${sessionId} does not exist`);
  }
  const workspace: SessionWorkspace = { root: mainRoot, kind: "main" };
  const stateRevision = sessionManager.migrateSessionMainRoot(sessionId, project, mainRoot);
  if (activeState?.sessionId === sessionId) {
    Object.assign(activeState, {
      project: { ...project },
      cwd: mainRoot,
      workspace,
      stateRevision,
    });
  }
  authorities.delete(sessionId);
  return workspace;
}

export function setOwnedSessionWorkspace(options: {
  sessionManager: SessionManager;
  activeState?: SessionState;
  sessionId: string;
  workspace: SessionWorkspace;
}): SessionWorkspace | null {
  const { sessionManager, activeState, sessionId, workspace } = options;
  if (!sessionId || !sessionManager.exists(sessionId)) return null;
  try {
    const stateRevision = sessionManager.setSessionWorkspace(sessionId, workspace);
    if (activeState?.sessionId === sessionId) {
      Object.assign(activeState, { workspace, stateRevision });
    }
    return workspace;
  } catch {
    return null;
  }
}

export function releaseOwnedSessionWorkspace(options: {
  sessionManager: SessionManager;
  activeState?: SessionState;
  sessionId: string;
}): SessionWorkspace | null {
  const { sessionManager, activeState, sessionId } = options;
  if (!sessionId || !sessionManager.exists(sessionId)) return null;
  const mainRoot =
    sessionManager.readSessionMainRoot(sessionId) ??
    (activeState?.sessionId === sessionId ? activeState.cwd : undefined);
  if (!mainRoot) return null;
  return setOwnedSessionWorkspace({
    sessionManager,
    activeState,
    sessionId,
    workspace: { root: mainRoot, kind: "main" },
  });
}
