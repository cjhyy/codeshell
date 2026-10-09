import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { CloudAccountApi, CloudAccountStatus } from "../shared/cloud-account.js";

export const cloudAccountApi: CloudAccountApi = {
  status: () => ipcRenderer.invoke("cloudAccount:status"),
  login: (input) => ipcRenderer.invoke("cloudAccount:login", input),
  register: (input) => ipcRenderer.invoke("cloudAccount:register", input),
  signInWithGitHub: (input) => ipcRenderer.invoke("cloudAccount:github", input),
  linkGitHub: () => ipcRenderer.invoke("cloudAccount:linkGitHub"),
  cancelSignIn: () => ipcRenderer.invoke("cloudAccount:cancelSignIn"),
  logout: () => ipcRenderer.invoke("cloudAccount:logout"),
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, status: CloudAccountStatus) => callback(status);
    ipcRenderer.on("cloudAccount:statusChanged", listener);
    return () => ipcRenderer.removeListener("cloudAccount:statusChanged", listener);
  },
};
