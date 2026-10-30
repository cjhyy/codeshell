import type {
  PetProjectionEvent,
  PetProjectionSnapshot,
  PetSessionProjection,
} from "../../preload/types";
import { normalizeLocalFilePaths } from "../chat/localFilePaths";
import { bufferPetProjectionEvent } from "./petReliability";

export type PetOverviewFilter = "all" | "pending" | "running";
export type PetProjectionStatus = "loading" | "ready" | "reconciling" | "error";

export interface PetState {
  projection: PetProjectionSnapshot | null;
  status: PetProjectionStatus;
  error?: string;
  needsSnapshot: boolean;
  /** Events arriving after a reset must be replayed onto the recovered baseline. */
  bufferedProjectionEvents: PetProjectionEvent[];
  snapshotRetryRevision: number;
  overviewFilter: PetOverviewFilter;
  overviewFocus: string | null;
  chatDraft: string;
  chatPathAttachments: string[];
  chatTranscript: unknown[];
  /** The last prompt a suggestion or follow-up inserted, so the next one can replace it. */
  chatInsertedPrompt?: string;
}

export const initialPetState: PetState = {
  projection: null,
  status: "loading",
  needsSnapshot: false,
  bufferedProjectionEvents: [],
  snapshotRetryRevision: 0,
  overviewFilter: "all",
  overviewFocus: null,
  chatDraft: "",
  chatPathAttachments: [],
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
  | { type: "set-chat-path-attachments"; paths: string[] }
  | { type: "clear-chat-draft" }
  | { type: "restore-chat-draft"; draft: string; paths: string[] }
  | { type: "insert-chat-prompt"; draft: string }
  | { type: "set-chat-transcript"; transcript: unknown[] };

function requireSnapshot(state: PetState, event?: PetProjectionEvent): PetState {
  const bufferedProjectionEvents = [...state.bufferedProjectionEvents];
  if (event) bufferPetProjectionEvent(bufferedProjectionEvents, event);
  return {
    ...state,
    status: "reconciling",
    needsSnapshot: true,
    error: undefined,
    bufferedProjectionEvents,
  };
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
    case "snapshot-received": {
      let next: PetState = {
        ...state,
        projection: action.snapshot,
        status: action.snapshot.workerState === "reconciling" ? "reconciling" : "ready",
        needsSnapshot: false,
        bufferedProjectionEvents: [],
        error: undefined,
      };
      for (const event of state.bufferedProjectionEvents) {
        if (event.generation < action.snapshot.generation) continue;
        next = petStateReducer(next, { type: "projection-event", event });
      }
      // A response can precede another buffered reset or still miss an event.
      // Retrigger the recovery effect even when needsSnapshot stayed true.
      if (next.needsSnapshot) next.snapshotRetryRevision += 1;
      return next;
    }
    case "snapshot-failed":
      return { ...state, status: "error", error: action.error };
    case "snapshot-retry":
      return { ...state, status: "reconciling", needsSnapshot: true, error: undefined };
    case "projection-event": {
      const snapshot = state.projection;
      if (!snapshot || state.needsSnapshot) return requireSnapshot(state, action.event);
      if (action.event.generation !== snapshot.generation)
        return requireSnapshot(state, action.event);
      if (action.event.version <= snapshot.version) return state;
      if (action.event.kind === "reset") return requireSnapshot(state, action.event);
      if (action.event.version !== snapshot.version + 1)
        return requireSnapshot(state, action.event);
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
    case "set-chat-path-attachments":
      return { ...state, chatPathAttachments: normalizeLocalFilePaths(action.paths) };
    case "clear-chat-draft":
      return { ...state, chatDraft: "", chatPathAttachments: [] };
    case "restore-chat-draft":
      return {
        ...state,
        chatDraft:
          state.chatDraft.trim() && state.chatDraft !== action.draft
            ? [state.chatDraft, action.draft].filter(Boolean).join("\n\n")
            : action.draft,
        chatPathAttachments: normalizeLocalFilePaths([
          ...state.chatPathAttachments,
          ...action.paths,
        ]),
      };
    case "insert-chat-prompt": {
      // Replace an empty draft or the previous inserted prompt; never stack the
      // same prompt twice, and keep anything the user typed by appending.
      const current = state.chatDraft;
      const chatDraft =
        !current.trim() || current === state.chatInsertedPrompt
          ? action.draft
          : current.includes(action.draft)
            ? current
            : `${current}\n\n${action.draft}`;
      return { ...state, chatDraft, chatInsertedPrompt: action.draft };
    }
    case "set-chat-transcript":
      return { ...state, chatTranscript: action.transcript };
  }
}
