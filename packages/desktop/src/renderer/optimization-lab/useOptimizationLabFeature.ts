import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ViewState } from "../view";

export function useOptimizationLabFeature(
  settingsRevision: number,
  setView: Dispatch<SetStateAction<ViewState>>,
) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void window.codeshell
      .getSettings("user")
      .then((settings) => {
        if (alive)
          setEnabled(
            (settings?.featureFlags as Record<string, boolean> | undefined)?.optimization_lab ===
              true,
          );
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, [settingsRevision]);
  useEffect(() => {
    if (enabled === false)
      setView((current) =>
        current.viewMode === "optimization_lab" ? { ...current, viewMode: "chat" } : current,
      );
  }, [enabled, setView]);
  return enabled === true;
}
