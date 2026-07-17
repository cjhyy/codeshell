import type {
  PetApi,
  PetAttentionEvent,
  PetPeek,
  PetProjectionEvent,
  StreamEventEnvelope,
} from "../../preload/types";
import React from "react";
import { foldTranscript } from "../automation/foldTranscript";
import {
  transcriptsReducer,
  type TranscriptsAction,
  type TranscriptsMap,
} from "../transcriptsReducer";
import { INITIAL_STATE, type MessagesReducerState } from "../types";
import {
  initialPetState,
  petStateReducer,
  type PetState,
  type PetStateAction,
} from "./petStateReducer";
import {
  bufferPetAttentionEvent,
  bufferPetProjectionEvent,
  PET_STREAM_BUFFER_LIMIT,
  petSnapshotRetryDelay,
  pushBoundedPetEvent,
} from "./petReliability";

export interface PetStateContextValue {
  state: PetState;
  dispatch: React.Dispatch<PetStateAction>;
  petSessionId: string | null;
  chatState: MessagesReducerState;
  chatDispatch: React.Dispatch<TranscriptsAction>;
  chatBusy: boolean;
  setChatBusy: React.Dispatch<React.SetStateAction<boolean>>;
  chatModelKey: string | null;
  setChatModelKey: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceablePendingCount: number;
  peeks: PetPeek[];
  removePeek: (id: string) => void;
}

export const PET_CHAT_BUCKET = "__codeshell_pet_chat__";
const PetStateContext = React.createContext<PetStateContextValue | null>(null);

export function PetStateProvider({
  children,
  api: apiOverride,
  snapshotRetryDelay = petSnapshotRetryDelay,
}: {
  children: React.ReactNode;
  api?: PetApi;
  snapshotRetryDelay?: (attempt: number) => number;
}) {
  const api = apiOverride ?? window.codeshell.pet;
  const [state, dispatch] = React.useReducer(petStateReducer, initialPetState);
  const [petSessionId, setPetSessionId] = React.useState<string | null>(null);
  const [chatBusy, setChatBusy] = React.useState(false);
  const [chatModelKey, setChatModelKey] = React.useState<string | null>(null);
  const [surfaceablePendingCount, setSurfaceablePendingCount] = React.useState(0);
  const [peeks, setPeeks] = React.useState<PetPeek[]>([]);
  const [chatTranscripts, chatDispatch] = React.useReducer(
    transcriptsReducer,
    {} as TranscriptsMap,
  );

  React.useEffect(() => {
    let active = true;
    let hydrated = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    const buffered: PetProjectionEvent[] = [];
    const unsubscribe = api.onProjectionEvent((event) => {
      if (!active) return;
      if (!hydrated) {
        bufferPetProjectionEvent(buffered, event);
        return;
      }
      dispatch({ type: "projection-event", event });
    });
    const requestSnapshot = (): void => {
      void api
        .getSnapshot()
        .then((snapshot) => {
          if (!active) return;
          dispatch({ type: "snapshot-received", snapshot });
          hydrated = true;
          for (const event of buffered) dispatch({ type: "projection-event", event });
          buffered.length = 0;
        })
        .catch((error) => {
          if (!active) return;
          dispatch({
            type: "snapshot-failed",
            error: error instanceof Error ? error.message : String(error),
          });
          retryTimer = setTimeout(requestSnapshot, snapshotRetryDelay(retryAttempt));
          retryAttempt += 1;
        });
    };
    requestSnapshot();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      buffered.length = 0;
      unsubscribe();
    };
  }, [api, snapshotRetryDelay]);

  React.useEffect(() => {
    if (!state.needsSnapshot) return;
    let active = true;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const requestSnapshot = (): void => {
      void api
        .getSnapshot()
        .then((snapshot) => {
          if (active) dispatch({ type: "snapshot-received", snapshot });
        })
        .catch((error) => {
          if (!active) return;
          dispatch({
            type: "snapshot-failed",
            error: error instanceof Error ? error.message : String(error),
          });
          retryTimer = setTimeout(requestSnapshot, snapshotRetryDelay(retryAttempt));
          retryAttempt += 1;
        });
    };
    requestSnapshot();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [api, snapshotRetryDelay, state.needsSnapshot]);

  React.useEffect(() => {
    let active = true;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let knownPetSessionId: string | null = null;
    let transcriptHydrated = false;
    const bufferedStream: StreamEventEnvelope[] = [];
    const shell = globalThis.window?.codeshell;

    const applyStream = (envelope: StreamEventEnvelope): void => {
      chatDispatch({ type: "stream", bucket: PET_CHAT_BUCKET, event: envelope.event });
      if (envelope.event.type === "stream_request_start") setChatBusy(true);
      if (envelope.event.type === "turn_complete" || envelope.event.type === "error") {
        setChatBusy(false);
      }
    };
    const receiveStream = (envelope: StreamEventEnvelope): void => {
      if (!active) return;
      if (!knownPetSessionId || !transcriptHydrated) {
        pushBoundedPetEvent(bufferedStream, envelope, PET_STREAM_BUFFER_LIMIT);
        return;
      }
      if (envelope.sessionId === knownPetSessionId) applyStream(envelope);
    };
    const unsubscribeStream = shell?.onStreamEvent?.(receiveStream);

    const finishHydration = (sessionId: string): void => {
      if (!active || knownPetSessionId !== sessionId) return;
      transcriptHydrated = true;
      for (const envelope of bufferedStream.splice(0)) {
        if (envelope.sessionId === sessionId) applyStream(envelope);
      }
    };

    const requestGlobalStatus = (): void => {
      void api
        .dispatch({ type: "get_global_status" })
        .then(async (result) => {
          if (!active) return;
          if (!result.ok || result.type !== "global_status") {
            retryTimer = setTimeout(requestGlobalStatus, snapshotRetryDelay(retryAttempt));
            retryAttempt += 1;
            return;
          }
          const sessionId = result.petSessionId;
          knownPetSessionId = sessionId;
          setPetSessionId(sessionId);
          if (!shell?.getSessionTranscript) {
            finishHydration(sessionId);
            return;
          }
          try {
            const transcript = await shell.getSessionTranscript(sessionId);
            if (active && knownPetSessionId === sessionId) {
              chatDispatch({
                type: "hydrate",
                bucket: PET_CHAT_BUCKET,
                state: foldTranscript(transcript),
              });
            }
          } catch {
            // A new Pet has no transcript yet; the first chat turn creates it.
          } finally {
            finishHydration(sessionId);
          }
        })
        .catch(() => {
          if (!active) return;
          retryTimer = setTimeout(requestGlobalStatus, snapshotRetryDelay(retryAttempt));
          retryAttempt += 1;
        });
    };
    requestGlobalStatus();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      bufferedStream.length = 0;
      unsubscribeStream?.();
    };
  }, [api, snapshotRetryDelay]);

  React.useEffect(() => {
    if (!api.onChatEvent) return;
    return api.onChatEvent((event) => {
      if (event.kind !== "user-submitted") return;
      chatDispatch({
        type: "user_message",
        bucket: PET_CHAT_BUCKET,
        text: event.message,
        clientMessageId: event.clientMessageId,
      });
    });
  }, [api]);

  React.useEffect(() => {
    let active = true;
    let hydrated = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const buffered: PetAttentionEvent[] = [];
    const applyEvent = (event: PetAttentionEvent) => {
      if (event.kind === "count") {
        setSurfaceablePendingCount(event.surfaceablePendingCount);
      } else {
        setPeeks((current) =>
          current.some((peek) => peek.id === event.peek.id) ? current : [...current, event.peek],
        );
      }
    };
    const unsubscribe = api.onAttentionEvent((event) => {
      if (!active) return;
      if (!hydrated) {
        bufferPetAttentionEvent(buffered, event);
        return;
      }
      applyEvent(event);
    });
    const requestAttentionSnapshot = (): void => {
      void api
        .getAttentionSnapshot()
        .then((snapshot) => {
          if (!active) return;
          setSurfaceablePendingCount(snapshot.surfaceablePendingCount);
          hydrated = true;
          for (const event of buffered) applyEvent(event);
          buffered.length = 0;
        })
        .catch(() => {
          if (!active) return;
          retryTimer = setTimeout(requestAttentionSnapshot, snapshotRetryDelay(retryAttempt));
          retryAttempt += 1;
        });
    };
    requestAttentionSnapshot();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      buffered.length = 0;
      unsubscribe();
    };
  }, [api, snapshotRetryDelay]);

  const chatState = chatTranscripts[PET_CHAT_BUCKET] ?? INITIAL_STATE;
  const value = React.useMemo(
    () => ({
      state,
      dispatch,
      petSessionId,
      chatState,
      chatDispatch,
      chatBusy,
      setChatBusy,
      chatModelKey,
      setChatModelKey,
      surfaceablePendingCount,
      peeks,
      removePeek: (id: string) => setPeeks((current) => current.filter((peek) => peek.id !== id)),
    }),
    [state, petSessionId, chatState, chatBusy, chatModelKey, surfaceablePendingCount, peeks],
  );
  return <PetStateContext.Provider value={value}>{children}</PetStateContext.Provider>;
}

export function usePetState(): PetStateContextValue {
  const context = React.useContext(PetStateContext);
  if (!context) throw new Error("usePetState must be used inside PetStateProvider");
  return context;
}

/**
 * Compatibility seam for legacy App unit harnesses that render <App />
 * directly. Production main.tsx always supplies PetStateProvider; this inert
 * value creates no subscriptions and can never auto-open a Pet surface.
 */
const INERT_PET_CONTEXT: PetStateContextValue = {
  state: initialPetState,
  dispatch: () => {},
  petSessionId: null,
  chatState: INITIAL_STATE,
  chatDispatch: () => {},
  chatBusy: false,
  setChatBusy: () => {},
  chatModelKey: null,
  setChatModelKey: () => {},
  surfaceablePendingCount: 0,
  peeks: [],
  removePeek: () => {},
};

export function useOptionalPetState(): PetStateContextValue {
  return React.useContext(PetStateContext) ?? INERT_PET_CONTEXT;
}
