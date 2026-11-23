import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { createTraceHistoryService } from "./trace-history-service.js";

type TraceHistory = ReturnType<typeof createTraceHistoryService>;
type TraceHistoryApi = {
  [K in keyof TraceHistory]: (
    ...args: Parameters<TraceHistory[K]>
  ) => ReturnType<TraceHistory[K]> | Promise<ReturnType<TraceHistory[K]>>;
};

/** Raw prompts and capture policy are available only to native application main frames. */
export function registerModelTraceIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  history: (event: IpcMainInvokeEvent) => TraceHistoryApi,
) {
  const trusted = (event: IpcMainInvokeEvent) =>
    windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  const channels: string[] = [];
  const handle = (
    channel: string,
    action: (service: TraceHistoryApi, input: unknown) => unknown,
  ) => {
    channels.push(channel);
    ipc.handle(channel, (event, input: unknown) => {
      if (!trusted(event)) throw new Error("Model history requires an application window");
      return action(history(event), input);
    });
  };
  handle("modelTraces:list", (service, query) => service.list(query));
  handle("modelTraces:sessions", (service, query) => service.sessions(query));
  handle("modelTraces:get", (service, id) => service.get(id));
  handle("modelTraces:getConfig", (service) => service.getConfig());
  handle("modelTraces:setConfig", (service, patch) => service.setConfig(patch));
  return {
    dispose: () => {
      for (const channel of channels) ipc.removeHandler(channel);
    },
  };
}
