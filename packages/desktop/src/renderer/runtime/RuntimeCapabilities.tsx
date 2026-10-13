import { createContext, useContext } from "react";

/** Remote paths and session IDs never authorize access to this computer. */
export const LocalRuntimeActionsContext = createContext(true);
export function useLocalRuntimeActions(): boolean {
  return useContext(LocalRuntimeActionsContext);
}
