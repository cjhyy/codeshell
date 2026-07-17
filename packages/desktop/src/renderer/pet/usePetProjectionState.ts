import type { PetApi, PetProjectionEvent } from "../../preload/types";
import React from "react";
import {
  bufferPetProjectionEvent,
  petSnapshotRetryDelay as defaultPetSnapshotRetryDelay,
} from "./petReliability";
import { initialPetState, petStateReducer, type PetState } from "./petStateReducer";

type ProjectionApi = Pick<PetApi, "getSnapshot" | "onProjectionEvent">;

export function usePetProjectionState(
  api: ProjectionApi,
  retryDelay: (attempt: number) => number = defaultPetSnapshotRetryDelay,
): PetState {
  const [state, dispatch] = React.useReducer(petStateReducer, initialPetState);
  const retryDelayRef = React.useRef(retryDelay);
  retryDelayRef.current = retryDelay;

  React.useEffect(() => {
    let active = true;
    let hydrated = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
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
      retryTimer = null;
      void api
        .getSnapshot()
        .then((snapshot) => {
          if (!active) return;
          dispatch({ type: "snapshot-received", snapshot });
          hydrated = true;
          retryAttempt = 0;
          for (const event of buffered.splice(0)) {
            dispatch({ type: "projection-event", event });
          }
        })
        .catch((error) => {
          if (!active) return;
          dispatch({
            type: "snapshot-failed",
            error: error instanceof Error ? error.message : String(error),
          });
          retryTimer = setTimeout(requestSnapshot, retryDelayRef.current(retryAttempt));
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
  }, [api]);

  React.useEffect(() => {
    if (!state.needsSnapshot) return;
    let active = true;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const requestSnapshot = (): void => {
      retryTimer = null;
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
          retryTimer = setTimeout(requestSnapshot, retryDelayRef.current(retryAttempt));
          retryAttempt += 1;
        });
    };
    requestSnapshot();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [api, state.needsSnapshot]);

  return state;
}
