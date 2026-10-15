import { createContext, useContext } from "react";

export interface PanelCatalogState {
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export const PanelCatalogContext = createContext<PanelCatalogState>({
  loading: false,
  error: null,
  refresh: () => {},
});

export function usePanelCatalogState(): PanelCatalogState {
  return useContext(PanelCatalogContext);
}
