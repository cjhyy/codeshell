export type PetWorkerState = "active" | "reclaimed" | "disconnected" | "reconciling" | "unknown";

export type PetSessionRunState = "dormant" | "idle" | "queued" | "running" | "terminal" | "unknown";

export interface PetSessionProjection {
  agentSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  runState: PetSessionRunState;
  phase?: "model" | "tool" | "waiting-decision" | "compacting" | "finalizing";
  summary?: string;
  queueDepth: number;
  lastActivityAt: number;
  pendingDecisionCount: number;
  terminal?: { status: "completed" | "failed" | "cancelled"; at: number };
  freshness: {
    source: "disk" | "live-snapshot" | "live-event";
    observedAt: number;
    workerState: PetWorkerState;
  };
}

export interface PetPendingDecision {
  agentSessionId: string;
  requestId: string;
  routeGeneration?: number;
  workerGeneration: number;
  kind: "tool_approval" | "ask_user";
  title: string;
  toolName?: string;
  riskLevel?: "low" | "medium" | "high";
  createdAt: number;
  expiresAt?: number;
  status: "pending" | "resolved" | "expired" | "cancelled" | "owner-lost";
  terminalAt?: number;
}

export interface PetProjectionSnapshot {
  version: number;
  generation: number;
  workerState: PetWorkerState;
  sessions: PetSessionProjection[];
  pending: PetPendingDecision[];
  observedAt: number;
}

interface PetProjectionEventBase {
  version: number;
  generation: number;
  observedAt: number;
}

export type PetProjectionEvent = PetProjectionEventBase &
  (
    | { kind: "session-upsert"; session: PetSessionProjection }
    | { kind: "session-remove"; sessionId: string }
    | { kind: "pending-upsert"; pending: PetPendingDecision }
    | { kind: "pending-remove"; sessionId: string; requestId: string }
    | { kind: "worker-state"; state: PetWorkerState }
    | { kind: "reset" }
  );

export interface PetApi {
  getSnapshot(): Promise<PetProjectionSnapshot>;
  onProjectionEvent(listener: (event: PetProjectionEvent) => void): () => void;
}

export interface PetIpcRenderer {
  invoke(channel: string): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: PetProjectionEvent) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, payload: PetProjectionEvent) => void,
  ): unknown;
}

export function createPetApi(ipcRenderer: PetIpcRenderer): PetApi {
  return {
    getSnapshot: () => ipcRenderer.invoke("pet:get-snapshot") as Promise<PetProjectionSnapshot>,
    onProjectionEvent: (listener) => {
      const handler = (_event: unknown, payload: PetProjectionEvent): void => listener(payload);
      ipcRenderer.on("pet:projection-event", handler);
      return () => ipcRenderer.removeListener("pet:projection-event", handler);
    },
  };
}
