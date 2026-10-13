import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  CloudEnvironmentApi,
  CloudEnvironmentEvent,
  CloudConnectionStatus,
  CloudIpcResult,
} from "../shared/cloud-environment";

async function invoke<T>(method: string, input: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(
    `cloudEnvironment:${method}`,
    input,
  )) as CloudIpcResult<T>;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), result.error);
}

export const cloudEnvironmentApi: CloudEnvironmentApi = {
  discover: (input) => invoke("discover", input),
  login: (input) => invoke("login", input),
  listBindings: (input) => invoke("listBindings", input),
  bind: (input) => invoke("bind", input),
  select: (input) => invoke("select", input),
  getSelection: (input) => invoke("getSelection", input),
  connect: (input) => invoke("connect", input),
  start: (input) => invoke("start", input),
  request: (input) => invoke("request", input),
  listSessions: (input) => invoke("listSessions", input),
  readConfiguration: (input) => invoke("readConfiguration", input),
  upload: (input) => invoke("upload", input),
  disconnect: (input) => invoke("disconnect", input),
  onEvent(callback) {
    const listener = (_event: IpcRendererEvent, payload: CloudEnvironmentEvent) =>
      callback(payload);
    ipcRenderer.on("cloudEnvironment:event", listener);
    return () => ipcRenderer.removeListener("cloudEnvironment:event", listener);
  },
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, payload: CloudConnectionStatus) =>
      callback(payload);
    ipcRenderer.on("cloudEnvironment:status", listener);
    return () => ipcRenderer.removeListener("cloudEnvironment:status", listener);
  },
};
