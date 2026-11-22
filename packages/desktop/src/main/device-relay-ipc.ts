import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopRelayEnrollment } from "../shared/device-relay.js";
import type { MobileRemoteController } from "./mobile-remote-controller.js";

export function registerDeviceRelayIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  controller: Pick<
    MobileRemoteController,
    "status" | "relayStatus" | "stop" | "forget" | "pairingUrl"
  > & {
    start(
      opts?: Parameters<MobileRemoteController["start"]>[0],
      document?: AbortSignal,
    ): ReturnType<MobileRemoteController["start"]>;
    enroll(
      input: DesktopRelayEnrollment,
      authorized: () => boolean,
      document?: AbortSignal,
    ): ReturnType<MobileRemoteController["enroll"]>;
  };
  documentSignal?: (event: IpcMainInvokeEvent) => AbortSignal;
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
    return controller.start(input, options.documentSignal?.(event));
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
    return controller.enroll(input, () => allowed(event), options.documentSignal?.(event));
  });
  ipcMain.handle("mobileRemote:relayForget", (event) => {
    requireOwner(event);
    return controller.forget();
  });
}
