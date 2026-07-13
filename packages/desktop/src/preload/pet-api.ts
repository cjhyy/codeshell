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

export interface PetOpenSessionRequest {
  agentSessionId: string;
  snapshotVersion: number;
  generation: number;
  requestId?: string;
  routeGeneration?: number;
}

export interface PetNavigationTarget {
  uiSessionId: string;
  engineSessionId: string;
  projectPath: string | null;
  title: string;
  updatedAt: number;
  origin: "desktop" | "automation";
  status?: "active" | "paused" | "completed" | "failed" | "cancelled";
}

export type PetOpenSessionResult =
  | { status: "not-found" }
  | {
      status: "ok" | "stale";
      target: PetNavigationTarget;
      pendingStatus?: "pending" | "resolved";
    };

export type PetDispatchCommand =
  | { type: "get_global_status" }
  | { type: "list_pending" }
  | { type: "open_session"; target: PetOpenSessionRequest }
  | { type: "chat"; message: string };

export type PetDispatchResult =
  | {
      ok: false;
      code: "unsupported-in-phase-1" | "invalid-command" | "worker-error";
      message?: string;
    }
  | {
      ok: true;
      type: "global_status";
      version: number;
      generation: number;
      observedAt: number;
      workerState: PetWorkerState;
      petSessionId: string;
      runningCount: number;
      queuedCount: number;
      pendingCount: number;
      sessions: PetSessionProjection[];
    }
  | { ok: true; type: "pending_list"; pending: PetPendingDecision[] }
  | { ok: true; type: "open_session"; result: PetOpenSessionResult }
  | { ok: true; type: "chat"; petSessionId: string; result: unknown };

export interface PetPeek {
  id: string;
  title: string;
  detail: string;
  receiptKeys: string[];
  action:
    | { type: "open_session"; target: PetOpenSessionRequest }
    | { type: "open_pet_pending"; count: number };
}

export interface PetAttentionSnapshot {
  surfaceablePendingCount: number;
}

export type PetAttentionEvent =
  | { kind: "count"; surfaceablePendingCount: number }
  | { kind: "peek"; peek: PetPeek };

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
  openSession(request: PetOpenSessionRequest): Promise<PetOpenSessionResult>;
  dispatch(command: PetDispatchCommand): Promise<PetDispatchResult>;
  getAttentionSnapshot(): Promise<PetAttentionSnapshot>;
  onAttentionEvent(listener: (event: PetAttentionEvent) => void): () => void;
  setActiveSession(sessionId: string | null): Promise<{ ok: true }>;
  markAttentionReceipt(keys: string[], state: "seen" | "dismissed"): Promise<{ ok: true }>;
}

export interface PetIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

export function createPetApi(ipcRenderer: PetIpcRenderer): PetApi {
  return {
    getSnapshot: () => ipcRenderer.invoke("pet:get-snapshot") as Promise<PetProjectionSnapshot>,
    openSession: (request) =>
      ipcRenderer.invoke("pet:open-session", request) as Promise<PetOpenSessionResult>,
    dispatch: (command) =>
      ipcRenderer.invoke("pet:dispatch", command) as Promise<PetDispatchResult>,
    onProjectionEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void =>
        listener(payload as PetProjectionEvent);
      ipcRenderer.on("pet:projection-event", handler);
      return () => ipcRenderer.removeListener("pet:projection-event", handler);
    },
    getAttentionSnapshot: () =>
      ipcRenderer.invoke("pet:get-attention") as Promise<PetAttentionSnapshot>,
    onAttentionEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void =>
        listener(payload as PetAttentionEvent);
      ipcRenderer.on("pet:attention-event", handler);
      return () => ipcRenderer.removeListener("pet:attention-event", handler);
    },
    setActiveSession: (sessionId) =>
      ipcRenderer.invoke("pet:set-active-session", sessionId) as Promise<{ ok: true }>,
    markAttentionReceipt: (keys, state) =>
      ipcRenderer.invoke("pet:attention-receipt", { keys, state }) as Promise<{ ok: true }>,
  };
}
