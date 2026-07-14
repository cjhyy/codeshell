import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type PluginPanelEvent = "context.changed";

const api = Object.freeze({
  getContext: () => ipcRenderer.invoke("plugin-panel:get-context"),
  call: (method: string, params?: unknown) =>
    ipcRenderer.invoke("plugin-panel:call", method, params),
  on: (event: PluginPanelEvent, listener: (payload: unknown) => void) => {
    if (event !== "context.changed" || typeof listener !== "function") {
      throw new Error("unsupported plugin panel event");
    }
    const handler = (
      _ipcEvent: IpcRendererEvent,
      message: { event?: unknown; payload?: unknown },
    ) => {
      if (message?.event === event) listener(message.payload);
    };
    ipcRenderer.on("plugin-panel:event", handler);
    return () => ipcRenderer.removeListener("plugin-panel:event", handler);
  },
});

contextBridge.exposeInMainWorld("codeshellPanel", api);
