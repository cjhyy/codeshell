export type PetWorkerState = "active" | "reclaimed" | "disconnected" | "reconciling" | "unknown";

export type PetChatEvent = {
  kind: "user-submitted";
  clientMessageId: string;
  message: string;
  createdAt: number;
  origin?: {
    channel: string;
    target: string;
    senderId: string;
    messageId?: string;
  };
};

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

/**
 * One topic-segment boundary surfaced to the Mimi chat UI: the client message
 * id of the first turn of a new segment plus the optional carryover brief
 * distilled from the segment that just closed. Rendered as a divider (+ an
 * optional read-only work-memory card) immediately before that message.
 *
 * NOTE: this is only populated once main can map a segment start to a chat
 * message id. The current work-memory store (Task 12) keeps a single active
 * segment keyed by time with no message-id association, so this array is
 * empty in practice; the renderer silently skips unmatched boundaries.
 */
export interface PetWorkMemorySegment {
  boundaryBeforeMessageId: string;
  brief?: string;
}

export interface PetWorkMemoryQuery {
  activeSegmentId: string | null;
  segments: PetWorkMemorySegment[];
}

export interface PetProjectionSnapshot {
  version: number;
  generation: number;
  workerState: PetWorkerState;
  sessions: PetSessionProjection[];
  pending: PetPendingDecision[];
  observedAt: number;
  /** Topic-segment boundaries for the Mimi chat stream (see PetWorkMemorySegment). */
  workMemorySegments?: PetWorkMemorySegment[];
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
  | {
      type: "chat";
      message: string;
      clientMessageId?: string;
      preferredProjectPath?: string;
      digitalHumanId?: string;
      digitalHumanTeamId?: string;
    };

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
  | {
      ok: true;
      type: "chat";
      petSessionId: string;
      result: unknown;
      delegation?: {
        clientMessageId: string;
        task: string;
        workspacePath: string | null;
        digitalHumanId?: string;
        sessionId: string;
        reusedSession: boolean;
      };
      delegations?: Array<{
        clientMessageId: string;
        task: string;
        workspacePath: string | null;
        digitalHumanId?: string;
        sessionId: string;
        reusedSession: boolean;
      }>;
      delegationError?: string;
    };

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

export interface PetWidgetPosition {
  x: number;
  y: number;
}

export interface PetWorkInboxSnapshot {
  revision: number;
  dismissedIds: string[];
}

export type PetWorkInboxUpdate =
  | { action: "add"; ids: string[] }
  | {
      action: "clear";
    };

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
  getWorkMemory(): Promise<PetWorkMemoryQuery>;
  onProjectionEvent(listener: (event: PetProjectionEvent) => void): () => void;
  openSession(request: PetOpenSessionRequest): Promise<PetOpenSessionResult>;
  dispatch(command: PetDispatchCommand): Promise<PetDispatchResult>;
  onChatEvent?(listener: (event: PetChatEvent) => void): () => void;
  getAttentionSnapshot(): Promise<PetAttentionSnapshot>;
  onAttentionEvent(listener: (event: PetAttentionEvent) => void): () => void;
  setActiveSession(sessionId: string | null): Promise<{ ok: true }>;
  markAttentionReceipt(keys: string[], state: "seen" | "dismissed"): Promise<{ ok: true }>;
  getDismissedWorkItemIds(): Promise<PetWorkInboxSnapshot>;
  updateDismissedWorkItemIds(update: PetWorkInboxUpdate): Promise<PetWorkInboxSnapshot>;
  onDismissedWorkItemIdsChanged(listener: (snapshot: PetWorkInboxSnapshot) => void): () => void;
  getWidgetVisibility(): Promise<boolean>;
  setWidgetVisible(visible: boolean): Promise<{ ok: true }>;
  setWidgetExpanded(expanded: boolean): Promise<{ ok: true }>;
  moveWidget(position: PetWidgetPosition): void;
  openWidgetOverview(target?: PetOpenSessionRequest): Promise<{ ok: true }>;
  onWidgetOpenOverview(listener: (target?: PetOpenSessionRequest) => void): () => void;
  onWidgetVisibilityChanged(listener: (visible: boolean) => void): () => void;
}

export interface PetIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  send(channel: string, payload?: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

export function createPetApi(ipcRenderer: PetIpcRenderer): PetApi {
  return {
    getSnapshot: () => ipcRenderer.invoke("pet:get-snapshot") as Promise<PetProjectionSnapshot>,
    getWorkMemory: () => ipcRenderer.invoke("pet:get-work-memory") as Promise<PetWorkMemoryQuery>,
    openSession: (request) =>
      ipcRenderer.invoke("pet:open-session", request) as Promise<PetOpenSessionResult>,
    dispatch: (command) =>
      ipcRenderer.invoke("pet:dispatch", command) as Promise<PetDispatchResult>,
    onChatEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void =>
        listener(payload as PetChatEvent);
      ipcRenderer.on("pet:chat-event", handler);
      return () => ipcRenderer.removeListener("pet:chat-event", handler);
    },
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
    getDismissedWorkItemIds: () =>
      ipcRenderer.invoke("pet:work-inbox-dismissed-get") as Promise<PetWorkInboxSnapshot>,
    updateDismissedWorkItemIds: (update) =>
      ipcRenderer.invoke(
        "pet:work-inbox-dismissed-update",
        update,
      ) as Promise<PetWorkInboxSnapshot>,
    onDismissedWorkItemIdsChanged: (listener) => {
      const handler = (_event: unknown, payload: unknown): void =>
        listener(payload as PetWorkInboxSnapshot);
      ipcRenderer.on("pet:work-inbox-dismissed-changed", handler);
      return () => ipcRenderer.removeListener("pet:work-inbox-dismissed-changed", handler);
    },
    getWidgetVisibility: () => ipcRenderer.invoke("pet:widget-visible-get") as Promise<boolean>,
    setWidgetVisible: (visible) =>
      ipcRenderer.invoke("pet:widget-visible", visible) as Promise<{ ok: true }>,
    setWidgetExpanded: (expanded) =>
      ipcRenderer.invoke("pet:widget-expanded", expanded) as Promise<{ ok: true }>,
    moveWidget: (position) => ipcRenderer.send("pet:widget-move", position),
    openWidgetOverview: (target) =>
      ipcRenderer.invoke("pet:widget-open-overview", target) as Promise<{ ok: true }>,
    onWidgetOpenOverview: (listener) => {
      const handler = (_event: unknown, target: unknown): void =>
        listener(target as PetOpenSessionRequest | undefined);
      ipcRenderer.on("pet:widget-open-overview", handler);
      return () => ipcRenderer.removeListener("pet:widget-open-overview", handler);
    },
    onWidgetVisibilityChanged: (listener) => {
      const handler = (_event: unknown, visible: unknown): void => {
        if (typeof visible === "boolean") listener(visible);
      };
      ipcRenderer.on("pet:widget-visibility-changed", handler);
      return () => ipcRenderer.removeListener("pet:widget-visibility-changed", handler);
    },
  };
}
