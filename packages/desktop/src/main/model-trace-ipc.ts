import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { createTraceHistoryService } from "./trace-history-service.js";

/** Raw prompts and capture policy are available only to native application main frames. */
export function registerModelTraceIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  history = createTraceHistoryService(),
) {
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
  handle("modelTraces:list", (query) => history.list(query));
  handle("modelTraces:get", (id) => history.get(id));
  handle("modelTraces:getConfig", () => history.getConfig());
  handle("modelTraces:setConfig", (patch) => history.setConfig(patch));
  return {
    dispose: () => {
      for (const channel of channels) ipc.removeHandler(channel);
    },
  };
}
