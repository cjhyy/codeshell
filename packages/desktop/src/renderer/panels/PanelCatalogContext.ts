import { createContext, useContext } from "react";

export interface PanelCatalogState {
  /** No usable catalog yet (first read, or retrying after a failure). */
  loading: boolean;
  /** A healthy catalog is being re-read in the background; keep showing it. */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export const PanelCatalogContext = createContext<PanelCatalogState>({
  loading: false,
  refreshing: false,
  error: null,
  refresh: () => {},
});

export function usePanelCatalogState(): PanelCatalogState {
  return useContext(PanelCatalogContext);
}
