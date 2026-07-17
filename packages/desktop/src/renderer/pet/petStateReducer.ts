import type {
  PetProjectionEvent,
  PetProjectionSnapshot,
  PetSessionProjection,
} from "../../preload/types";

export type PetOverviewFilter = "all" | "pending" | "running";
export type PetProjectionStatus = "loading" | "ready" | "reconciling" | "error";

export interface PetState {
  projection: PetProjectionSnapshot | null;
  status: PetProjectionStatus;
  error?: string;
  needsSnapshot: boolean;
  overviewFilter: PetOverviewFilter;
  overviewFocus: string | null;
  chatDraft: string;
  chatTranscript: unknown[];
}

export const initialPetState: PetState = {
  projection: null,
  status: "loading",
  needsSnapshot: false,
  overviewFilter: "all",
  overviewFocus: null,
  chatDraft: "",
  chatTranscript: [],
};

export type PetStateAction =
  | { type: "snapshot-received"; snapshot: PetProjectionSnapshot }
  | { type: "snapshot-failed"; error: string }
  | { type: "snapshot-retry" }
  | { type: "projection-event"; event: PetProjectionEvent }
  | { type: "set-overview-filter"; filter: PetOverviewFilter }
  | { type: "set-overview-focus"; focus: string | null }
  | { type: "set-chat-draft"; draft: string }
  | { type: "set-chat-transcript"; transcript: unknown[] };

function requireSnapshot(state: PetState): PetState {
  return { ...state, status: "reconciling", needsSnapshot: true, error: undefined };
}

function upsertSession(
  sessions: readonly PetSessionProjection[],
  session: PetSessionProjection,
): PetSessionProjection[] {
  const next = sessions.filter((entry) => entry.agentSessionId !== session.agentSessionId);
  next.push(session);
  next.sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
  return next;
}

function applyProjectionEvent(
  snapshot: PetProjectionSnapshot,
  event: Exclude<PetProjectionEvent, { kind: "reset" }>,
): PetProjectionSnapshot {
  const next: PetProjectionSnapshot = {
    ...snapshot,
    version: event.version,
    generation: event.generation,
    observedAt: event.observedAt,
  };
  switch (event.kind) {
    case "session-upsert":
      return { ...next, sessions: upsertSession(snapshot.sessions, event.session) };
    case "session-remove":
      return {
        ...next,
        sessions: snapshot.sessions.filter((session) => session.agentSessionId !== event.sessionId),
      };
    case "pending-upsert":
      return {
        ...next,
        pending: [
          ...snapshot.pending.filter(
            (pending) =>
              pending.agentSessionId !== event.pending.agentSessionId ||
              pending.requestId !== event.pending.requestId,
          ),
          event.pending,
        ],
      };
    case "pending-remove":
      return {
        ...next,
        pending: snapshot.pending.filter(
          (pending) =>
            pending.agentSessionId !== event.sessionId || pending.requestId !== event.requestId,
        ),
      };
    case "worker-state":
      return { ...next, workerState: event.state };
    case "work-memory-segments":
      return { ...next, workMemorySegments: event.segments };
  }
}

export function petStateReducer(state: PetState, action: PetStateAction): PetState {
  switch (action.type) {
    case "snapshot-received":
      return {
        ...state,
        projection: action.snapshot,
        status: action.snapshot.workerState === "reconciling" ? "reconciling" : "ready",
        needsSnapshot: false,
        error: undefined,
      };
    case "snapshot-failed":
      return { ...state, status: "error", error: action.error };
    case "snapshot-retry":
      return { ...state, status: "reconciling", needsSnapshot: true, error: undefined };
    case "projection-event": {
      const snapshot = state.projection;
      if (!snapshot) return requireSnapshot(state);
      if (state.needsSnapshot) return state;
      if (action.event.generation !== snapshot.generation) return requireSnapshot(state);
      if (action.event.version <= snapshot.version) return state;
      if (action.event.kind === "reset") return requireSnapshot(state);
      if (action.event.version !== snapshot.version + 1) return requireSnapshot(state);
      return {
        ...state,
        projection: applyProjectionEvent(snapshot, action.event),
        status:
          action.event.kind === "worker-state" && action.event.state === "reconciling"
            ? "reconciling"
            : "ready",
        needsSnapshot: false,
        error: undefined,
      };
    }
    case "set-overview-filter":
      return { ...state, overviewFilter: action.filter };
    case "set-overview-focus":
      return { ...state, overviewFocus: action.focus };
    case "set-chat-draft":
      return { ...state, chatDraft: action.draft };
    case "set-chat-transcript":
      return { ...state, chatTranscript: action.transcript };
  }
}
