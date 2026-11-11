import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { ActivityHistoryWorker } from "./activity-history-worker-client.js";
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
  history?: TraceHistoryApi,
) {
  const owned = history ? undefined : new ActivityHistoryWorker({ sessionsDir: sessionsRoot() });
  const service = history ?? owned!;
  const trusted = (event: IpcMainInvokeEvent) =>
    windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  const channels: string[] = [];
  const handle = (channel: string, action: (input: unknown) => unknown) => {
    channels.push(channel);
    ipc.handle(channel, (event, input: unknown) => {
      if (!trusted(event)) throw new Error("Model history requires an application window");
      return action(input);
    });
  };
  handle("modelTraces:list", (query) => service.list(query));
  handle("modelTraces:sessions", (query) => service.sessions(query));
  handle("modelTraces:get", (id) => service.get(id));
  handle("modelTraces:getConfig", () => service.getConfig());
  handle("modelTraces:setConfig", (patch) => service.setConfig(patch));
  return {
    dispose: () => {
      for (const channel of channels) ipc.removeHandler(channel);
      return owned?.close();
    },
  };
}
