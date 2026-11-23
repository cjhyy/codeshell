import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import type { PetIpcMainLike } from "../pet/pet-ipc.js";

/** Native surfaces can disappear or navigate between two consecutive broadcasts. */
export function trustedMimiWindows(
  windows: Iterable<BrowserWindow>,
  navigation: Pick<AppRendererNavigation, "assertSender">,
): BrowserWindow[] {
  return Array.from(windows).filter((window) => {
    if (window.isDestroyed()) return false;
    try {
      navigation.assertSender({
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      });
      return true;
    } catch {
      return false;
    }
  });
}

/** Capture the invoking document before any cold-start wait, then recheck the window and grant. */
export function mimiWindowIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  documentSignal: (event: IpcMainInvokeEvent) => AbortSignal,
  ready: Promise<void>,
): PetIpcMainLike {
  return {
    handle(channel, listener) {
      ipc.handle(channel, async (event, ...args) => {
        const belongs = () => windows().some((window) => window.webContents === event.sender);
        if (!belongs()) throw Error("Mimi requires a workbench or companion window");
        const signal = documentSignal(event);
        await ready;
        signal.throwIfAborted();
        if (!belongs()) throw Error("Mimi window is no longer available");
        return listener(event, ...args);
      });
    },
    removeHandler: (channel) => ipc.removeHandler(channel),
  };
}
