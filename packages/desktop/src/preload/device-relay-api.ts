import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopRelayApi, DesktopRelayStatus } from "../shared/device-relay.js";

export const deviceRelayApi: DesktopRelayApi = {
  status: () => ipcRenderer.invoke("mobileRemote:relayStatus"),
  enroll: (input) => ipcRenderer.invoke("mobileRemote:relayEnroll", input),
  forget: () => ipcRenderer.invoke("mobileRemote:relayForget"),
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, status: DesktopRelayStatus) => callback(status);
    ipcRenderer.on("mobileRemote:relayStatusChanged", listener);
    return () => ipcRenderer.removeListener("mobileRemote:relayStatusChanged", listener);
  },
};
