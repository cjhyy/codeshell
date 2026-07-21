import type {
  SessionOrigin,
  SessionStatus,
  StreamEvent,
  TurnCompletionKind,
} from "@cjhyy/code-shell-core/extension";

export const LOCAL_PET_OWNER = "local-user" as const;
export type PetOwnerId = typeof LOCAL_PET_OWNER;

export type PetWorkerState = "active" | "reclaimed" | "disconnected" | "unknown";
export type PetSessionRunState = "dormant" | "idle" | "queued" | "running" | "terminal" | "unknown";
export type PetSessionPhase = "model" | "tool" | "waiting-decision" | "compacting" | "finalizing";
export type PetTerminalStatus = "completed" | "failed" | "cancelled";

export interface PetProjectionCursor {
  generation: number;
  version: number;
  observedAt: number;
}

export interface PetProjectionFreshness {
  source: "disk" | "live-snapshot" | "live-event";
  observedAt: number;
  workerState: PetWorkerState;
}

export interface PetSessionProjection {
  owner: PetOwnerId;
  agentSessionId: string;
  coreSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  runState: PetSessionRunState;
  phase?: PetSessionPhase;
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  pendingDecisionCount: number;
  /** Exceptional completed-run boundary that is waiting for recovery/continuation. */
  completionKind?: TurnCompletionKind;
  terminal?: { status: PetTerminalStatus; at: number };
  freshness: PetProjectionFreshness;
}

export interface PetCatalogSession {
  sessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  updatedAt: number;
  origin?: SessionOrigin;
  kind?: "work" | "pet";
  ephemeral?: boolean;
  parentSessionId?: string | null;
  status?: SessionStatus;
  completionKind?: TurnCompletionKind;
}

export interface PetOwnerScopedCatalog {
  owner: PetOwnerId;
  sessions: readonly PetCatalogSession[];
  observedAt: number;
}

export interface PetLiveSessionState {
  sessionId: string;
  busy: boolean;
  queueDepth: number;
  lastActivityAt: number;
}

export interface PetLiveSessionsSnapshot extends PetProjectionCursor {
  sessions: readonly PetLiveSessionState[];
}

export interface PetSessionStreamEvent extends PetProjectionCursor {
  sessionId: string;
  event: StreamEvent;
}

export interface PetWorkerLifecycleEvent extends PetProjectionCursor {
  state: Exclude<PetWorkerState, "unknown">;
}

export type PendingDecisionKind = "tool_approval" | "ask_user";
export type PendingDecisionStatus = "pending" | "resolved" | "expired" | "cancelled" | "owner-lost";

export interface PendingDecisionProjection {
  owner: PetOwnerId;
  agentSessionId: string;
  coreSessionId: string;
  requestId: string;
  routeGeneration?: number;
  workerGeneration: number;
  kind: PendingDecisionKind;
  title: string;
  toolName?: string;
  riskLevel?: "low" | "medium" | "high";
  createdAt: number;
  expiresAt?: number;
  status: PendingDecisionStatus;
  terminalAt?: number;
}

export interface PetProjectionSnapshot {
  snapshotVersion: number;
  workerGeneration: number;
  observedAt: number;
  sessions: PetSessionProjection[];
  pending: PendingDecisionProjection[];
}
