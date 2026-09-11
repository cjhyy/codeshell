import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { SessionCatalogStore } from "./session-catalog-store.js";
import { SessionTranscriptCache } from "./session-transcript-cache.js";

/** Only application windows can read or mutate the private session directory. */
export function registerSessionCatalogIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  catalog = new SessionCatalogStore(),
  transcripts = new SessionTranscriptCache(),
) {
  const channels: string[] = [];
  const pendingFlushes = new Map<
    string,
    {
      sender: IpcMainInvokeEvent["sender"];
      finish: (ok: boolean) => void;
    }
  >();
  const trustedEvent = (event: IpcMainInvokeEvent) =>
    windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  const handle = (channel: string, action: (input: any) => Promise<unknown>) => {
    channels.push(channel);
    ipc.handle(channel, (event: IpcMainInvokeEvent, input: unknown) => {
      if (!trustedEvent(event)) {
        throw new Error("session catalogue requires an application window");
      }
      return action(input);
    });
  };
  handle("sessionCatalog:load", () => catalog.load());
  handle("sessionCatalog:importLegacy", (indices) => catalog.importLegacy(indices));
  handle("sessionCatalog:apply", (patch) => catalog.apply(patch));
  handle("sessionCatalog:writeTranscript", (input) => transcripts.write(input));
  handle("sessionCatalog:readTranscript", (input) => transcripts.read(input));
  handle("sessionCatalog:deleteTranscript", (input) => transcripts.delete(input));
  channels.push("sessionCatalog:flushComplete");
  ipc.handle("sessionCatalog:flushComplete", (event, input) => {
    if (!trustedEvent(event) || typeof input?.requestId !== "string") return;
    const pending = pendingFlushes.get(input.requestId);
    if (pending?.sender === event.sender) pending.finish(input.ok === true);
  });
  const unsubscribe = catalog.onChanged((snapshot) => {
    for (const window of windows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("sessionCatalog:changed", snapshot);
      } catch {
        // A window closing after the check cannot invalidate a durable write.
      }
    }
  });
  return {
    flushRenderers: async () => {
      await Promise.all(
        windows()
          .filter((window) => !window.isDestroyed())
          .map(
            (window) =>
              new Promise<void>((resolve, reject) => {
                const requestId = randomUUID();
                const finish = (ok: boolean) => {
                  clearTimeout(timer);
                  pendingFlushes.delete(requestId);
                  if (ok || window.isDestroyed()) resolve();
                  else reject(new Error("Session changes could not be saved before quitting"));
                };
                const timer = setTimeout(() => finish(false), 10_000);
                pendingFlushes.set(requestId, { sender: window.webContents, finish });
                try {
                  window.webContents.send("sessionCatalog:flushRequested", requestId);
                } catch {
                  finish(false);
                }
              }),
          ),
      );
      await Promise.all([catalog.flush(), transcripts.flush()]);
    },
    flush: async () => {
      await Promise.all([catalog.flush(), transcripts.flush()]);
    },
    dispose: () => {
      unsubscribe();
      for (const channel of channels) ipc.removeHandler(channel);
    },
  };
}
