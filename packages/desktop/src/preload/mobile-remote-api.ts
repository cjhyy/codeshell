import { ipcRenderer, type IpcRendererEvent } from "electron";
import { deviceRelayApi } from "./device-relay-api.js";
import type { MobileRemoteApi } from "../shared/mobile-remote.js";

/** Local transport adapters only; remote services remain opt-in in Main. */
export const mobileRemoteApi: MobileRemoteApi = {
  relay: deviceRelayApi,
  start: (opts?: { mode?: "lan" | "tunnel" | "relay" }) =>
    ipcRenderer.invoke("mobileRemote:start", opts),
  stop: () => ipcRenderer.invoke("mobileRemote:stop"),
  pairingUrl: () => ipcRenderer.invoke("mobileRemote:pairingUrl"),
  status: () => ipcRenderer.invoke("mobileRemote:status"),
  listDevices: () => ipcRenderer.invoke("mobileRemote:listDevices"),
  revokeDevice: (id: string) => ipcRenderer.invoke("mobileRemote:revokeDevice", id),
  removeDevice: (id: string) => ipcRenderer.invoke("mobileRemote:removeDevice", id),
  renameDevice: (id: string, name: string) =>
    ipcRenderer.invoke("mobileRemote:renameDevice", id, name),
  onlineDevices: () => ipcRenderer.invoke("mobileRemote:onlineDevices"),
  onOnlineChange: (cb: (ids: string[]) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, ids: string[]) => cb(ids);
    ipcRenderer.on("mobileRemote:onlineChange", h);
    return () => ipcRenderer.removeListener("mobileRemote:onlineChange", h);
  },
  // ── Public tunnel mode ──
  cloudflaredInstalled: () => ipcRenderer.invoke("mobileRemote:cloudflaredInstalled"),
  downloadCloudflared: () => ipcRenderer.invoke("mobileRemote:downloadCloudflared"),
  onDownloadProgress: (cb: (pct: number) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, pct: number) => cb(pct);
    ipcRenderer.on("mobileRemote:downloadProgress", h);
    return () => ipcRenderer.removeListener("mobileRemote:downloadProgress", h);
  },
  passcodeStatus: () => ipcRenderer.invoke("mobileRemote:passcodeStatus"),
  setPasscode: (passcode: string) => ipcRenderer.invoke("mobileRemote:setPasscode", passcode),
  tunnelStatus: () => ipcRenderer.invoke("mobileRemote:tunnelStatus"),
  onTunnelStatus: (cb: (s: { status: string; detail?: unknown }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, payload: { status: string; detail?: unknown }) => cb(payload);
    ipcRenderer.on("mobileRemote:tunnelStatus", h);
    return () => ipcRenderer.removeListener("mobileRemote:tunnelStatus", h);
  },
  updatePermissionModes: (entries: Array<{ sessionId: string; mode: string }>) =>
    ipcRenderer.invoke("mobileRemote:updatePermissionModes", entries),
  notifyApprovalResolved: (input: {
    requestId: string;
    sessionId?: string;
    approved?: boolean;
    answer?: string;
  }) => ipcRenderer.invoke("mobileRemote:approvalResolved", input),
};
