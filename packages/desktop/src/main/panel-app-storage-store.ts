/** Shared Node storage contract; keep Desktop and remote Web on the same store. */
export {
  DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES,
  panelAppStorageKey,
  panelAppStoragePath,
  panelAppStorageQuotaBytes,
  preparePanelAppStorage,
  readPanelAppStorage,
  writePanelAppStorage,
  type PanelAppStorage,
} from "@cjhyy/code-shell-server/storage";
