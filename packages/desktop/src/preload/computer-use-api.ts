import type { IpcRenderer } from "electron";
import type { ComputerUseSettingsApi } from "../shared/computer-use.js";

export function createComputerUseSettingsApi(
  ipc: Pick<IpcRenderer, "invoke">,
): ComputerUseSettingsApi {
  return {
    status: () => ipc.invoke("computerUse:status"),
    setEnabled: (enabled) => ipc.invoke("computerUse:setEnabled", enabled),
    requestPermission: (kind) => ipc.invoke("computerUse:requestPermission", kind),
    openSettings: (kind) => ipc.invoke("computerUse:openSettings", kind),
    restart: () => ipc.invoke("computerUse:restart"),
  };
}
