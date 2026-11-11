import { useCallback, useEffect, useRef, useState } from "react";
import type { PetApi } from "../../../preload/pet-api";
import type { PetNoticesState } from "../../../shared/pet-notices";

export type NoticesReadApi = Pick<PetApi, "getNoticesState" | "onNoticesChanged">;

/** The preload's Mimi API, when this window has one. */
export function defaultNoticesApi(): PetApi | undefined {
  try {
    return window.codeshell?.pet;
  } catch {
    return undefined;
  }
}

/**
 * Main's notice state (channels, system rule, settings), read-only and kept
 * fresh on `onNoticesChanged`. For views that show rules without editing.
 */
export function usePetNoticesState(api: NoticesReadApi | undefined = defaultNoticesApi()) {
  const [state, setState] = useState<PetNoticesState | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const apiRef = useRef(api);
  apiRef.current = api;
  const alive = useRef(false);
  const generation = useRef(0);

  /** Refetch; the promise settles (never rejects) once this read has landed or failed. */
  const reload = useCallback((): Promise<void> => {
    const current = apiRef.current;
    const id = ++generation.current;
    if (!current?.getNoticesState) {
      setLoadError("unavailable");
      setLoadState("error");
      return Promise.resolve();
    }
    return current.getNoticesState().then(
      (next) => {
        if (!alive.current || id !== generation.current) return;
        setState(next);
        setLoadState("ready");
      },
      (cause: unknown) => {
        if (!alive.current || id !== generation.current) return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
        // A failed refresh keeps the last good state on screen.
        setLoadState((previous) => (previous === "ready" ? previous : "error"));
      },
    );
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    const off = apiRef.current?.onNoticesChanged?.(reload);
    return () => {
      alive.current = false;
      generation.current += 1;
      off?.();
    };
  }, [reload]);

  return { state, loadState, loadError, reload };
}
