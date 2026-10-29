import type { IpcRenderer } from "electron";
import type { PanelAppBindingResult, PanelAppUninstallResult } from "../shared/panel-apps.js";

/** Keep mutation receipts intact so renderer callers can display execution blockers. */
export function createPanelMutationApi(ipcRenderer: Pick<IpcRenderer, "invoke">) {
  return {
    setPanelAppProjectBinding: (
      cwd: string,
      id: string,
      bound: boolean,
      expectedRevision: string,
    ): Promise<PanelAppBindingResult> =>
      ipcRenderer.invoke("panel-apps:setProjectBinding", cwd, id, bound, expectedRevision),
    uninstallPanelApp: (id: string, cwd?: string): Promise<PanelAppUninstallResult> =>
      ipcRenderer.invoke("panel-apps:uninstall", id, cwd),
  };
}
