import { contextBridge, ipcRenderer } from "electron";
import type { MimiCompanionApi } from "../shared/mimi-companion.js";

const api: MimiCompanionApi = {
  getState: () => ipcRenderer.invoke("mimiCompanion:state"),
  onState: (listener) => {
    const receive = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("mimiCompanion:state", receive);
    return () => ipcRenderer.removeListener("mimiCompanion:state", receive);
  },
  ready: (result) => ipcRenderer.send("mimiCompanion:ready", result),
  interaction: (phase) => ipcRenderer.send("mimiCompanion:interaction", phase),
  move: (position) => ipcRenderer.send("mimiCompanion:move", position),
  openChat: () => ipcRenderer.invoke("mimiCompanion:chat"),
  handoff: (accept) => ipcRenderer.invoke("mimiCompanion:handoff", accept),
  resumeFollowing: () => ipcRenderer.send("mimiCompanion:follow"),
  stopComputer: () => ipcRenderer.send("mimiCompanion:stopComputer"),
  resumeComputer: () => ipcRenderer.send("mimiCompanion:resumeComputer"),
};

contextBridge.exposeInMainWorld("mimiCompanion", api);
