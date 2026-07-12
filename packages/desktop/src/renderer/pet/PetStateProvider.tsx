import type { PetApi, PetPeek, PetProjectionEvent } from "../../preload/types";
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
}: {
  children: React.ReactNode;
  api?: PetApi;
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
    const buffered: PetProjectionEvent[] = [];
    const unsubscribe = api.onProjectionEvent((event) => {
      if (!active) return;
      if (!hydrated) {
        buffered.push(event);
        return;
      }
      dispatch({ type: "projection-event", event });
    });
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
        hydrated = true;
        dispatch({
          type: "snapshot-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
      buffered.length = 0;
      unsubscribe();
    };
  }, [api]);

  React.useEffect(() => {
    if (!state.needsSnapshot) return;
    let active = true;
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
      });
    return () => {
      active = false;
    };
  }, [api, state.needsSnapshot]);

  React.useEffect(() => {
    let active = true;
    void api.dispatch({ type: "get_global_status" }).then(async (result) => {
      if (!active || !result.ok || result.type !== "global_status") return;
      setPetSessionId(result.petSessionId);
      const shell = globalThis.window?.codeshell;
      if (!shell?.getSessionTranscript) return;
      try {
        const transcript = await shell.getSessionTranscript(result.petSessionId);
        if (active) {
          chatDispatch({
            type: "hydrate",
            bucket: PET_CHAT_BUCKET,
            state: foldTranscript(transcript),
          });
        }
      } catch {
        // A new Pet has no transcript yet; the first chat turn creates it.
      }
    });
    return () => {
      active = false;
    };
  }, [api]);

  React.useEffect(() => {
    if (!petSessionId) return;
    const shell = globalThis.window?.codeshell;
    if (!shell?.onStreamEvent) return;
    return shell.onStreamEvent((envelope) => {
      if (envelope.sessionId !== petSessionId) return;
      chatDispatch({ type: "stream", bucket: PET_CHAT_BUCKET, event: envelope.event });
      if (envelope.event.type === "stream_request_start") setChatBusy(true);
      if (envelope.event.type === "turn_complete" || envelope.event.type === "error") {
        setChatBusy(false);
      }
    });
  }, [petSessionId]);

  React.useEffect(() => {
    let active = true;
    const unsubscribe = api.onAttentionEvent((event) => {
      if (!active) return;
      if (event.kind === "count") {
        setSurfaceablePendingCount(event.surfaceablePendingCount);
      } else {
        setPeeks((current) =>
          current.some((peek) => peek.id === event.peek.id) ? current : [...current, event.peek],
        );
      }
    });
    void api
      .getAttentionSnapshot()
      .then((snapshot) => {
        if (active) setSurfaceablePendingCount(snapshot.surfaceablePendingCount);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

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
