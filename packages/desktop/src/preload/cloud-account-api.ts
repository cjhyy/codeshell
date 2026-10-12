import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  CloudAccountApi,
  CloudAccountStatus,
  CloudAccountGitHubRequest,
} from "../shared/cloud-account.js";

const github = (input: CloudAccountGitHubRequest): Promise<CloudAccountStatus> =>
  ipcRenderer.invoke("cloudAccount:github", input);

export const cloudAccountApi: CloudAccountApi = {
  status: () => ipcRenderer.invoke("cloudAccount:status"),
  capabilities: (origin) => ipcRenderer.invoke("cloudAccount:capabilities", origin),
  login: (input) => ipcRenderer.invoke("cloudAccount:login", input),
  register: (input) => ipcRenderer.invoke("cloudAccount:register", input),
  signInWithGitHub: (input) => github({ mode: "login", input }),
  linkGitHub: () => github({ mode: "link" }),
  manageLinks: (input) => ipcRenderer.invoke("cloudAccount:links", input),
  cancelSignIn: () => ipcRenderer.invoke("cloudAccount:cancelSignIn"),
  logout: () => ipcRenderer.invoke("cloudAccount:logout"),
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, status: CloudAccountStatus) => callback(status);
    ipcRenderer.on("cloudAccount:statusChanged", listener);
    return () => ipcRenderer.removeListener("cloudAccount:statusChanged", listener);
  },
};
