import type { ParsedRpc } from "./agent-bridge-fallback.js";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import { canonicalKey, type WorkspaceContext } from "@cjhyy/code-shell-core/internal";
import type { SessionCwdIndexEntry } from "./session-cwd-index.js";

export interface PreparedAgentRunMetadata {
  parsed: ParsedRpc;
  outLine: string;
  cwd?: string;
  sessionId?: string;
  bucket?: string;
  browserPartition?: string;
  meta: WorkerFrameMeta;
  tentative?: Omit<SessionCwdIndexEntry, "sessionId" | "status">;
}

export interface ResolvedAgentProjectRun {
  cwd: string;
  trustCwd: string;
  projectId: string;
  mainRootId: string;
  projectPrimaryRootId: string;
  workspaceContext: WorkspaceContext;
}

export interface AgentRunMetadataDeps {
  isProjectTrusted: (cwd: string) => boolean;
  resolveProjectRun?: (
    projectId: string,
    sessionId: string,
    session: SessionCwdIndexEntry | undefined,
  ) => ResolvedAgentProjectRun;
  resolveExactRoot?: (cwd: string) => ResolvedAgentProjectRun | undefined;
  lookupSession?: (sessionId: string, refresh: boolean) => SessionCwdIndexEntry | undefined;
  isNoRepoCwd?: (cwd: string) => boolean;
  hostReservation?: (sessionId: string) => HostReservation | undefined;
}

export class AgentRunMetadataError extends Error {
  readonly code = -32602;
}

export interface HostReservation {
  cwd: string;
  producer: string;
  reservedAt: number;
}

export function reserveHostSessionMaps(
  sessionCwd: Map<string, string>,
  reservations: Map<string, HostReservation>,
  sessionId: string,
  cwd: string,
  producer: string,
  reservedAt = Date.now(),
): void {
  sessionCwd.set(sessionId, cwd);
  reservations.set(sessionId, { cwd, producer, reservedAt });
}

export function forgetHostSessionMaps(
  sessionCwd: Map<string, string>,
  reservations: Map<string, HostReservation>,
  sessionId: string,
): void {
  sessionCwd.delete(sessionId);
  reservations.delete(sessionId);
}

export function prepareAgentRunMetadata(
  line: string,
  meta: WorkerFrameMeta,
  deps: AgentRunMetadataDeps,
): PreparedAgentRunMetadata {
  let parsed: ParsedRpc = {};
  try {
    parsed = JSON.parse(line) as ParsedRpc;
  } catch {
    return { parsed, outLine: line, meta };
  }
  if (parsed.method !== "agent/run") return { parsed, outLine: line, meta };

  const paramsRecord =
    parsed.params && typeof parsed.params === "object"
      ? (parsed.params as Record<string, unknown>)
      : undefined;
  const requestedCwd = typeof paramsRecord?.cwd === "string" ? paramsRecord.cwd : undefined;
  let cwd = requestedCwd;
  const sessionId =
    typeof paramsRecord?.sessionId === "string" ? paramsRecord.sessionId : undefined;
  const bucket = typeof paramsRecord?.bucket === "string" ? paramsRecord.bucket : undefined;
  const browserPartition =
    typeof paramsRecord?.browserPartition === "string" ? paramsRecord.browserPartition : undefined;

  if (paramsRecord) {
    delete paramsRecord.bucket;
    delete paramsRecord.browserPartition;
    delete paramsRecord.workspaceContext;
    delete paramsRecord.projectTrusted;
    const projectId =
      typeof paramsRecord.projectId === "string" && paramsRecord.projectId.length > 0
        ? paramsRecord.projectId
        : undefined;
    if (projectId) {
      if (!sessionId) throw new AgentRunMetadataError("project run requires a sessionId");
      if (!deps.resolveProjectRun) {
        throw new AgentRunMetadataError("project registry is unavailable");
      }
      let session = deps.lookupSession?.(sessionId, false);
      if (!session) session = deps.lookupSession?.(sessionId, true);
      try {
        const resolution = deps.resolveProjectRun(projectId, sessionId, session);
        return prepareResolvedProject({
          parsed,
          paramsRecord,
          resolution,
          sessionId,
          bucket,
          browserPartition,
          meta,
          isTrusted: deps.isProjectTrusted(resolution.trustCwd),
          tentative: session?.status !== "confirmed",
        });
      } catch (error) {
        throw new AgentRunMetadataError(
          error instanceof Error ? error.message : "project run could not be resolved",
        );
      }
    }

    if (!sessionId) throw new AgentRunMetadataError("agent run requires a sessionId");
    let session = deps.lookupSession?.(sessionId, false);
    let refreshed = false;
    if (!session) {
      session = deps.lookupSession?.(sessionId, true);
      refreshed = true;
    }
    if (session) {
      if (
        meta.origin !== "host" &&
        requestedCwd !== undefined &&
        !matchesSessionCwd(requestedCwd, session)
      ) {
        session = refreshed ? session : deps.lookupSession?.(sessionId, true);
        if (!session || !matchesSessionCwd(requestedCwd, session)) {
          throw new AgentRunMetadataError(
            "requested cwd does not match persisted Session workspace",
          );
        }
      }
      if (session.projectId) {
        if (!deps.resolveProjectRun) throw new AgentRunMetadataError("project registry is unavailable");
        try {
          const resolution = deps.resolveProjectRun(session.projectId, sessionId, session);
          return prepareResolvedProject({
            parsed,
            paramsRecord,
            resolution,
            sessionId,
            bucket,
            browserPartition,
            meta,
            isTrusted: deps.isProjectTrusted(resolution.trustCwd),
            tentative: session.status === "tentative",
          });
        } catch (error) {
          throw new AgentRunMetadataError(
            error instanceof Error ? error.message : "bound project run could not be resolved",
          );
        }
      }

      cwd = session.workspaceRoot ?? session.cwd;
      paramsRecord.cwd = cwd;
      delete paramsRecord.projectId;
      paramsRecord.projectTrusted = deps.isProjectTrusted(session.cwd);
      return {
        parsed,
        outLine: JSON.stringify(parsed),
        cwd,
        sessionId,
        bucket,
        browserPartition,
        meta,
        ...(session.status === "tentative"
          ? { tentative: tentativeFromSession(session) }
          : {}),
      };
    }

    if (!requestedCwd) {
      throw new AgentRunMetadataError("new agent run requires an authorized cwd or projectId");
    }
    if (deps.isNoRepoCwd?.(requestedCwd)) {
      return prepareLegacyNew(parsed, paramsRecord, requestedCwd, sessionId, bucket, browserPartition, meta, deps);
    }
    const root = deps.resolveExactRoot?.(requestedCwd);
    if (root) {
      if (root.mainRootId === root.projectPrimaryRootId) {
        return prepareResolvedProject({
          parsed,
          paramsRecord,
          resolution: root,
          sessionId,
          bucket,
          browserPartition,
          meta,
          isTrusted: deps.isProjectTrusted(root.trustCwd),
          tentative: true,
        });
      }
      return prepareLegacyNew(parsed, paramsRecord, root.cwd, sessionId, bucket, browserPartition, meta, deps);
    }
    const reservation = meta.origin === "host" ? deps.hostReservation?.(sessionId) : undefined;
    if (reservation && canonicalKey(reservation.cwd) === canonicalKey(requestedCwd)) {
      return prepareLegacyNew(parsed, paramsRecord, reservation.cwd, sessionId, bucket, browserPartition, meta, deps);
    }
    throw new AgentRunMetadataError("new agent run cwd is not authorized");
  }

  return { parsed, outLine: line, cwd, sessionId, bucket, browserPartition, meta };
}

function prepareResolvedProject(args: {
  parsed: ParsedRpc;
  paramsRecord: Record<string, unknown>;
  resolution: ResolvedAgentProjectRun;
  sessionId: string;
  bucket?: string;
  browserPartition?: string;
  meta: WorkerFrameMeta;
  isTrusted: boolean;
  tentative: boolean;
}): PreparedAgentRunMetadata {
  const { resolution } = args;
  args.paramsRecord.cwd = resolution.cwd;
  args.paramsRecord.projectId = resolution.projectId;
  args.paramsRecord.workspaceContext = resolution.workspaceContext;
  args.paramsRecord.projectTrusted = args.isTrusted;
  return {
    parsed: args.parsed,
    outLine: JSON.stringify(args.parsed),
    cwd: resolution.cwd,
    sessionId: args.sessionId,
    bucket: args.bucket,
    browserPartition: args.browserPartition,
    meta: args.meta,
    ...(args.tentative
      ? {
          tentative: {
            cwd: resolution.trustCwd,
            workspaceRoot: resolution.cwd,
            projectId: resolution.projectId,
            mainRootId: resolution.mainRootId,
          },
        }
      : {}),
  };
}

function prepareLegacyNew(
  parsed: ParsedRpc,
  paramsRecord: Record<string, unknown>,
  cwd: string,
  sessionId: string,
  bucket: string | undefined,
  browserPartition: string | undefined,
  meta: WorkerFrameMeta,
  deps: AgentRunMetadataDeps,
): PreparedAgentRunMetadata {
  paramsRecord.cwd = cwd;
  delete paramsRecord.projectId;
  delete paramsRecord.workspaceContext;
  paramsRecord.projectTrusted = deps.isProjectTrusted(cwd);
  return {
    parsed,
    outLine: JSON.stringify(parsed),
    cwd,
    sessionId,
    bucket,
    browserPartition,
    meta,
    tentative: { cwd, workspaceRoot: cwd },
  };
}

function matchesSessionCwd(cwd: string, entry: SessionCwdIndexEntry): boolean {
  const key = canonicalKey(cwd);
  return key === canonicalKey(entry.cwd) ||
    (entry.workspaceRoot !== undefined && key === canonicalKey(entry.workspaceRoot));
}

function tentativeFromSession(
  entry: SessionCwdIndexEntry,
): Omit<SessionCwdIndexEntry, "sessionId" | "status"> {
  return {
    cwd: entry.cwd,
    ...(entry.workspaceRoot ? { workspaceRoot: entry.workspaceRoot } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.mainRootId ? { mainRootId: entry.mainRootId } : {}),
  };
}

export function resolveCredentialSessionCwd(
  sessionId: string,
  sessionCwd: ReadonlyMap<string, string>,
  readPersistedCwd: (sessionId: string) => string | undefined,
): string {
  const cwd = sessionCwd.get(sessionId) ?? readPersistedCwd(sessionId);
  if (!cwd) {
    throw new Error(`no cwd registered for session ${sessionId}`);
  }
  return cwd;
}
