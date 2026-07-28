import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type PanelAppEvent = "context.changed";

const api = Object.freeze({
  getContext: () => ipcRenderer.invoke("panel-app:get-context"),
  call: (method: string, params?: unknown) => ipcRenderer.invoke("panel-app:call", method, params),
  on: (event: PanelAppEvent, listener: (payload: unknown) => void) => {
    if (event !== "context.changed" || typeof listener !== "function") {
      throw new Error("unsupported Panel App event");
    }
    const handler = (
      _ipcEvent: IpcRendererEvent,
      message: { event?: unknown; payload?: unknown },
    ) => {
      if (message?.event === event) listener(message.payload);
    };
    ipcRenderer.on("panel-app:event", handler);
    return () => ipcRenderer.removeListener("panel-app:event", handler);
  },
});

contextBridge.exposeInMainWorld("codeshellPanel", api);
