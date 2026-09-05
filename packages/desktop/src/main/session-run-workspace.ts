import { canonicalKey, type WorkspaceContext } from "@cjhyy/code-shell-core/internal";
import { prepareAgentRunMetadata, type AgentRunMetadataDeps } from "./agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "./session-cwd-index.js";

export interface SessionRunWorkspace {
  cwd: string;
  workspaceContext?: WorkspaceContext;
  projectTrusted: boolean;
}

/**
 * Resolve a worker-originated turn through the same project registry and trust
 * decision as an ordinary host run. Session ids are the only caller inputs:
 * catalog paths and the source's active worktree cannot choose target authority.
 */
export function resolveSessionRunWorkspace(
  input: { sourceSessionId: string; targetSessionId: string },
  deps: AgentRunMetadataDeps,
): SessionRunWorkspace {
  const source = refreshSession(input.sourceSessionId, deps);
  if (!source) throw new Error("source Session workspace is unavailable");
  const target = refreshSession(input.targetSessionId, deps);
  if (target) {
    if (source.projectId && target.projectId) {
      if (source.projectId !== target.projectId) {
        throw new Error("target Session belongs to another project");
      }
    } else if (canonicalKey(source.cwd) !== canonicalKey(target.cwd)) {
      throw new Error("target Session does not share the source's authorized main root");
    }
  }

  // Pin the fresh target snapshot throughout resolution. In particular, an old
  // cached project binding must not override a completed main-root migration.
  const targetDeps: AgentRunMetadataDeps = {
    ...deps,
    lookupSession: (sessionId) => (sessionId === input.targetSessionId ? target : undefined),
  };
  const params: Record<string, unknown> = { sessionId: input.targetSessionId };
  if (!target && source.projectId) {
    if (!source.mainRootId) throw new Error("source Session project binding is incomplete");
    params.projectId = source.projectId;
    params.rootId = source.mainRootId;
  } else if (!target) {
    // Planned legacy Sessions remain legacy, including when the path was later
    // registered as a project. Resolving an exact root here would silently bind
    // them to that newer project.
    deps.validatePersistedRoot?.(source.cwd);
    return { cwd: source.cwd, projectTrusted: deps.isProjectTrusted(source.cwd) };
  }

  const prepared = prepareAgentRunMetadata(
    JSON.stringify({ jsonrpc: "2.0", method: "agent/run", params }),
    { origin: "host", producer: "session-message-workspace" },
    targetDeps,
  );
  const resolved = prepared.parsed.params as Record<string, unknown>;
  if (!prepared.cwd) throw new Error("target Session workspace could not be resolved");
  return {
    cwd: prepared.cwd,
    ...(resolved.workspaceContext
      ? { workspaceContext: resolved.workspaceContext as WorkspaceContext }
      : {}),
    projectTrusted: resolved.projectTrusted === true,
  };
}

function refreshSession(
  sessionId: string,
  deps: AgentRunMetadataDeps,
): SessionCwdIndexEntry | undefined {
  if (
    !sessionId ||
    sessionId.length > 512 ||
    /[\\/\0]/u.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".."
  ) {
    throw new Error("invalid Session id");
  }
  const cached = deps.lookupSession?.(sessionId, false);
  const fresh = deps.lookupSession?.(sessionId, true);
  // Tentative entries describe host-authorized Sessions not persisted yet.
  // A confirmed entry that disappeared from disk must never be resurrected.
  if (cached?.status === "confirmed" && !fresh) {
    throw new Error(`Session ${sessionId} is no longer available`);
  }
  return fresh ?? (cached?.status === "tentative" ? cached : undefined);
}
