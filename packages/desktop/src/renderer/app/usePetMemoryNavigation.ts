import { useCallback, useRef } from "react";
import type { ViewMode } from "../view";

/**
 * The Mimi memory center opens from both the workspace chat header and Mimi
 * settings. Back returns to whichever surface opened it.
 */
export function usePetMemoryNavigation({
  openPetPage,
  setViewMode,
}: {
  openPetPage: () => void;
  setViewMode: (view: ViewMode) => void;
}): {
  openPetMemory: (origin: "workspace" | "settings") => void;
  leavePetMemory: () => void;
} {
  const originRef = useRef<"workspace" | "settings">("settings");
  const openPetMemory = useCallback(
    (origin: "workspace" | "settings") => {
      originRef.current = origin;
      setViewMode("pet_memory");
    },
    [setViewMode],
  );
  const leavePetMemory = useCallback(() => {
    if (originRef.current === "workspace") openPetPage();
    else setViewMode("pet_settings");
  }, [openPetPage, setViewMode]);
  return { openPetMemory, leavePetMemory };
}
