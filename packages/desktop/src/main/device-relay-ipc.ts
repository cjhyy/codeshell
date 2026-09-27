import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopRelayEnrollment } from "../shared/device-relay.js";
import type { MobileRemoteController } from "./mobile-remote-controller.js";

export function registerDeviceRelayIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  controller: MobileRemoteController;
  isMainWindow: (sender: WebContents) => boolean;
}) {
  const { ipcMain, controller } = options;
  const allowed = (event: IpcMainInvokeEvent) =>
    !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    options.isMainWindow(event.sender);
  const requireOwner = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error("电脑登记只能由桌面主窗口管理。");
  };
  ipcMain.handle("mobileRemote:start", (event, input?: { mode?: "lan" | "tunnel" | "relay" }) => {
    requireOwner(event);
    return controller.start(input);
  });
  ipcMain.handle("mobileRemote:stop", (event) => {
    requireOwner(event);
    return controller.stop();
  });
  ipcMain.handle("mobileRemote:pairingUrl", (event) => {
    requireOwner(event);
    return controller.pairingUrl();
  });
  ipcMain.handle("mobileRemote:status", (event) => {
    requireOwner(event);
    return controller.status();
  });
  ipcMain.handle("mobileRemote:relayStatus", (event) => {
    requireOwner(event);
    return controller.relayStatus();
  });
  ipcMain.handle("mobileRemote:relayEnroll", (event, input: DesktopRelayEnrollment) => {
    requireOwner(event);
    return controller.enroll(input, () => allowed(event));
  });
  ipcMain.handle("mobileRemote:relayForget", (event) => {
    requireOwner(event);
    return controller.forget();
  });
}
