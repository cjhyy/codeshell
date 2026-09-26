import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { localFileExists, readLocalFilePreview } from "./local-file-preview-service.js";

export function registerLocalFilePreviewIpc(
  ipcMain: Pick<IpcMain, "handle">,
  isMainWindow: (sender: WebContents) => boolean,
): void {
  const isAllowed = (event: IpcMainInvokeEvent): boolean =>
    event.senderFrame === event.sender.mainFrame && isMainWindow(event.sender);

  ipcMain.handle("fsLocal:exists", async (event, path: unknown) => {
    if (!isAllowed(event)) return false;
    return localFileExists(path);
  });
  ipcMain.handle("fsLocal:readPreview", async (event, path: unknown) => {
    if (!isAllowed(event)) throw new Error("Local file previews require the Desktop main window");
    return readLocalFilePreview(path);
  });
}
