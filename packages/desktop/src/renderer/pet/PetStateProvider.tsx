import type { PetApi, PetProjectionEvent } from "../../preload/types";
import React from "react";
import {
  initialPetState,
  petStateReducer,
  type PetState,
  type PetStateAction,
} from "./petStateReducer";

export interface PetStateContextValue {
  state: PetState;
  dispatch: React.Dispatch<PetStateAction>;
}

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

  const value = React.useMemo(() => ({ state, dispatch }), [state]);
  return <PetStateContext.Provider value={value}>{children}</PetStateContext.Provider>;
}

export function usePetState(): PetStateContextValue {
  const context = React.useContext(PetStateContext);
  if (!context) throw new Error("usePetState must be used inside PetStateProvider");
  return context;
}
