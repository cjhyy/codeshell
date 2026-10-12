import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { CloudManagementManager } from "./cloud-management-manager.js";

/** Preserve the existing Cloud entry, with explicit owner-checked management requests. */
export function registerCloudWorkbenchIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  manager: Pick<CloudManagementManager, "manage">;
  isMainWindow: (contents: WebContents) => boolean;
  openLegacy: (address: unknown) => Promise<{ address: string }>;
}) {
  const allowed = (event: IpcMainInvokeEvent) =>
    !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    options.isMainWindow(event.sender);
  options.ipcMain.handle("cloud:open-workbench", (event, input: unknown) => {
    if (!allowed(event)) throw new Error("云端入口仅允许从主窗口打开。");
    return typeof input === "string"
      ? options.openLegacy(input)
      : options.manager.manage(input, () => allowed(event));
  });
}
