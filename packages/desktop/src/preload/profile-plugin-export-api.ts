import type { IpcRenderer } from "electron";
import type { ProfilePluginExportApi } from "../shared/profile-plugin-export.js";

export function createProfilePluginExportApi(
  ipc: Pick<IpcRenderer, "invoke">,
): ProfilePluginExportApi {
  return {
    previewProfilePluginExport: (name, target, selection) =>
      ipc.invoke("profiles:previewPluginExport", name, target, selection),
    cancelProfilePluginExport: (token) => ipc.invoke("profiles:cancelPluginExport", token),
    commitProfilePluginExport: (token, target, acceptLosses) =>
      ipc.invoke("profiles:commitPluginExport", token, target, acceptLosses),
  };
}
