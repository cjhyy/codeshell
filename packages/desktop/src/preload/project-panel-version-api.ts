import type { IpcRenderer } from "electron";
import type { ProjectPanelVersionApi } from "./project-panel-version-types";

/** Transparent transport for the Host's project package review lifecycle. */
export function createProjectPanelVersionApi(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): ProjectPanelVersionApi {
  return {
    getPanelAppPackageHistory: (cwd, id, revision) =>
      ipcRenderer.invoke("panel-apps:packageHistory", cwd, id, revision),
    previewPanelAppRestore: (cwd, id, digest, revision) =>
      ipcRenderer.invoke("panel-apps:previewRestore", cwd, id, digest, revision),
    restorePanelAppPackage: (cwd, token) => ipcRenderer.invoke("panel-apps:restore", cwd, token),
    cancelPanelAppRestore: (cwd, token) =>
      ipcRenderer.invoke("panel-apps:cancelRestore", cwd, token),
  };
}
