/**
 * Pet projection as a protocol extension. The Pet (Mimi) projection state
 * machine used to live inline in protocol/server.ts; it is now a generic
 * ProtocolObserver produced by createPetCapability() so the server stays
 * domain-agnostic. The observer owns the whole projection state (session
 * index, pending-decision index, catalog, version fence, closing latch) and
 * pushes deltas through the host's notify channel.
 *
 * Hosts register this via createPetCapability() (see capability.ts) — core
 * has no pet defaults.
 */
import type { StreamEvent } from "@cjhyy/code-shell-core/extension";
import type { PendingApprovalMetadata } from "@cjhyy/code-shell-core/extension";
import {
  GET_PET_PROJECTION_SNAPSHOT_METHOD,
  PET_PROJECTION_DELTA_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
} from "./protocol.js";
import type { ProtocolObserver, ProtocolObserverHost } from "@cjhyy/code-shell-core/extension";
import { PendingDecisionIndex } from "./pending-decision-index.js";
import { SessionIndex } from "./session-index.js";
import {
  LOCAL_PET_OWNER,
  type PendingDecisionProjection,
  type PendingDecisionStatus,
  type PetSessionProjection,
} from "./types.js";

/** Session kinds owned by the pet domain — hidden from generic session lists. */
export const PET_HIDDEN_SESSION_KINDS: readonly string[] = ["pet"];

function validateRuntimeContext(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value.length > 32_768) {
    return `${label} must be bounded JSON`;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `${label} must be a JSON object`;
    }
  } catch {
    return `${label} must be valid JSON`;
  }
  return null;
}

function validateWorkspaces(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length > 64) {
    return `${label} must be a bounded array`;
  }
  const ids = new Set<string>();
  for (const entry of value) {
    const workspace = entry as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
    } | null;
    if (
      !workspace ||
      typeof workspace !== "object" ||
      typeof workspace.id !== "string" ||
      !workspace.id.trim() ||
      workspace.id.length > 128 ||
      typeof workspace.name !== "string" ||
      !workspace.name.trim() ||
      workspace.name.length > 256 ||
      (workspace.description !== undefined &&
        (typeof workspace.description !== "string" || workspace.description.length > 4_096)) ||
      ids.has(workspace.id)
    ) {
      return `${label} contains an invalid or duplicate Workspace`;
    }
    ids.add(workspace.id);
  }
  return null;
}

/**
 * Pet-specific agent/run params validation. This validator owns only Pet
 * requests: other extension modes and kinds must pass through untouched. For
 * Pet runs it validates the effective generic profileParams values using the
 * same precedence as Engine (canonical keys override deprecated aliases).
 */
export function validatePetRunParams(params: Record<string, unknown>): string | null {
  const hasLegacyRuntimeContext = params.petRuntimeContext !== undefined;
  const hasLegacyWorkspaces = params.petWorkspaces !== undefined;
  const isPetRequest =
    params.behaviorMode === "pet" ||
    params.kind === "pet" ||
    hasLegacyRuntimeContext ||
    hasLegacyWorkspaces;
  if (!isPetRequest) return null;

  if (hasLegacyRuntimeContext && (params.behaviorMode !== "pet" || params.kind !== "pet")) {
    return "petRuntimeContext requires behaviorMode=pet and kind=pet";
  }
  if (hasLegacyWorkspaces && (params.behaviorMode !== "pet" || params.kind !== "pet")) {
    return "petWorkspaces requires behaviorMode=pet and kind=pet";
  }

  const profileParams =
    params.profileParams &&
    typeof params.profileParams === "object" &&
    !Array.isArray(params.profileParams)
      ? (params.profileParams as Record<string, unknown>)
      : undefined;
  const hasCanonicalRuntimeContext =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "runtimeContext");
  const hasCanonicalWorkspaces =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "workspaces");

  const runtimeContext = hasCanonicalRuntimeContext
    ? profileParams.runtimeContext
    : params.petRuntimeContext;
  if (runtimeContext !== undefined) {
    const error = validateRuntimeContext(
      runtimeContext,
      hasCanonicalRuntimeContext ? "profileParams.runtimeContext" : "petRuntimeContext",
    );
    if (error) return error;
  }

  const workspaces = hasCanonicalWorkspaces ? profileParams.workspaces : params.petWorkspaces;
  if (workspaces !== undefined) {
    const error = validateWorkspaces(
      workspaces,
      hasCanonicalWorkspaces ? "profileParams.workspaces" : "petWorkspaces",
    );
    if (error) return error;
  }
  return null;
}

/**
 * Build the pet projection observer. All former AgentServer pet state and
 * methods live here, keyed off the domain-neutral host surface.
 */
export function createPetProjectionObserver(host: ProtocolObserverHost): ProtocolObserver {
  const pendingDecisionIndex = new PendingDecisionIndex();
  const petSessionIndex = new SessionIndex();
  const petCatalog = new Map<string, { sessionId: string; updatedAt: number }>();
  let petProjectionVersion = 0;
  let petProjectionDisconnected = false;
  let petProjectionClosing = false;

  const petWorkerGeneration = (): number => host.projectionGeneration();

  const nextPetProjectionVersion = (): number => {
    petProjectionVersion += 1;
    return petProjectionVersion;
  };

  const sendPetProjectionDelta = (delta: PetProjectionDelta): void => {
    // Socket teardown can resolve a fail-closed approval and finish its run.
    // Do not write projection tail events to a transport whose owner is gone.
    if (host.isTransportDisconnected() && !petProjectionClosing) return;
    host.notify(PET_PROJECTION_DELTA_METHOD, delta as unknown as Record<string, unknown>);
  };

  const ensurePetSession = (sessionId: string, updatedAt = Date.now()): void => {
    const previous = petCatalog.get(sessionId);
    petCatalog.set(sessionId, {
      sessionId,
      updatedAt: Math.max(previous?.updatedAt ?? 0, updatedAt),
    });
    petSessionIndex.replaceCatalog({
      owner: LOCAL_PET_OWNER,
      sessions: [...petCatalog.values()],
      observedAt: updatedAt,
    });
  };

  const currentPetSessionProjection = (
    sessionId: string,
    observedAt: number,
  ): PetSessionProjection | undefined => {
    const live = host.getLiveSessionSnapshot().find((session) => session.sessionId === sessionId);
    if (!live || live.kind === "pet") return undefined;
    ensurePetSession(sessionId, live.lastActivityAt);
    const indexed = petSessionIndex.get(sessionId);
    const pendingDecisionCount = pendingDecisionIndex
      .pendingSnapshot()
      .filter((entry) => entry.agentSessionId === sessionId).length;
    const runState = live.busy ? "running" : live.queueDepth > 0 ? "queued" : "idle";
    return {
      owner: LOCAL_PET_OWNER,
      agentSessionId: sessionId,
      coreSessionId: sessionId,
      title: indexed?.title,
      workspaceDisplayName: indexed?.workspaceDisplayName,
      runState,
      phase: pendingDecisionCount > 0 ? "waiting-decision" : indexed?.phase,
      summary:
        pendingDecisionCount > 0
          ? pendingDecisionCount === 1
            ? "等待用户决定"
            : `等待用户决定（${pendingDecisionCount}）`
          : (indexed?.summary ?? (runState === "running" ? "运行中" : undefined)),
      queueDepth: live.queueDepth,
      lastActivityAt: live.lastActivityAt,
      pendingDecisionCount,
      terminal: runState === "idle" ? undefined : indexed?.terminal,
      freshness: { source: "live-snapshot", observedAt, workerState: "active" },
    };
  };

  const buildPetProjectionSnapshot = (): PetProjectionSnapshotResult => {
    const observedAt = Date.now();
    const sessions = host
      .getLiveSessionSnapshot()
      .filter((session) => session.kind !== "pet")
      .map((session) => currentPetSessionProjection(session.sessionId, observedAt))
      .filter((session): session is PetSessionProjection => session !== undefined)
      .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
    return {
      snapshotVersion: petProjectionVersion,
      workerGeneration: petWorkerGeneration(),
      observedAt,
      sessions,
      pending: pendingDecisionIndex.pendingSnapshot(),
    };
  };

  const recordPetStreamEvent = (sessionId: string, event: StreamEvent): void => {
    const observedAt = Date.now();
    const live = host.getLiveSessionSnapshot().find((session) => session.sessionId === sessionId);
    if (live?.kind === "pet") return;
    ensurePetSession(sessionId, observedAt);
    const version = nextPetProjectionVersion();
    petSessionIndex.applyStreamEvent({
      sessionId,
      event,
      generation: petWorkerGeneration(),
      version,
      observedAt,
    });
    const session = currentPetSessionProjection(sessionId, observedAt);
    if (!session) return;
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version,
      observedAt,
      kind: "session-upsert",
      session,
    });
  };

  const emitPetSessionUpsert = (sessionId: string): void => {
    const observedAt = Date.now();
    const session = currentPetSessionProjection(sessionId, observedAt);
    if (!session) return;
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version: nextPetProjectionVersion(),
      observedAt,
      kind: "session-upsert",
      session,
    });
  };

  const emitPetSessionRemove = (sessionId: string): void => {
    const observedAt = Date.now();
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version: nextPetProjectionVersion(),
      observedAt,
      kind: "session-remove",
      sessionId,
    });
  };

  const emitPetPendingUpsert = (pending: PendingDecisionProjection): void => {
    const observedAt = Date.now();
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version: nextPetProjectionVersion(),
      observedAt,
      kind: "pending-upsert",
      pending,
    });
  };

  const transitionPendingDecision = (
    metadata: PendingApprovalMetadata,
    status: Exclude<PendingDecisionStatus, "pending">,
  ): void => {
    const observedAt = Date.now();
    if (
      !pendingDecisionIndex.transition({
        sessionId: metadata.sessionId,
        requestId: metadata.requestId,
        routeGeneration: metadata.routeGeneration,
        status,
        terminalAt: observedAt,
      })
    ) {
      return;
    }
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version: nextPetProjectionVersion(),
      observedAt,
      kind: "pending-remove",
      sessionId: metadata.sessionId,
      requestId: metadata.requestId,
      status,
    });
    emitPetSessionUpsert(metadata.sessionId);
  };

  const emitPetWorkerDisconnected = (): void => {
    if (petProjectionDisconnected) return;
    petProjectionDisconnected = true;
    const observedAt = Date.now();
    const version = nextPetProjectionVersion();
    petSessionIndex.applyWorkerLifecycle({
      state: "disconnected",
      generation: petWorkerGeneration(),
      version,
      observedAt,
    });
    sendPetProjectionDelta({
      workerGeneration: petWorkerGeneration(),
      version,
      observedAt,
      kind: "worker-state",
      state: "disconnected",
    });
  };

  // Compat channel: the wire method name stays agent/getPetProjectionSnapshot;
  // the server routes it through this registration instead of pet-specific code.
  host.registerQuery(GET_PET_PROJECTION_SNAPSHOT_METHOD, () => buildPetProjectionSnapshot());

  return {
    onSessionAttached: (sessionId, lastActivityAt) => {
      ensurePetSession(sessionId, lastActivityAt);
    },
    onSessionStream: (sessionId, event) => {
      recordPetStreamEvent(sessionId, event);
    },
    onRunBoundary: (sessionId) => {
      emitPetSessionUpsert(sessionId);
    },
    onApprovalCreated: (metadata) => {
      if (host.getSessionKind(metadata.sessionId) === "pet") {
        metadata = { ...metadata, surfaceable: false };
      }
      if (pendingDecisionIndex.created(metadata)) {
        const pending = pendingDecisionIndex.get(metadata.sessionId, metadata.requestId);
        if (pending) {
          emitPetPendingUpsert(pending);
          emitPetSessionUpsert(metadata.sessionId);
        }
      }
      return metadata;
    },
    onApprovalTransition: (metadata, status) => {
      if (status === "pending") return;
      transitionPendingDecision(metadata, status as Exclude<PendingDecisionStatus, "pending">);
    },
    onSessionClosed: (sessionId) => {
      petCatalog.delete(sessionId);
      emitPetSessionRemove(sessionId);
    },
    onServerClose: () => {
      petProjectionClosing = true;
      emitPetWorkerDisconnected();
    },
    snapshotPendingDecisions: () => pendingDecisionIndex.snapshot(),
  };
}
