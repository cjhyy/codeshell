import type { App, BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { AccountFeatureService } from "@cjhyy/code-shell-server/account";
import type { CloudAccountStatus } from "../shared/cloud-account.js";
import type { DesktopRelayStatus } from "../shared/device-relay.js";
import type { ResolveAccountFeaturesInput } from "@cjhyy/code-shell-web/account";
export { AccountFeatureService };
/** Credential loading starts only after Electron's safe storage is ready. */
export function bindAccountFeatureLifecycle(
  app: Pick<App, "on" | "once" | "whenReady">,
  service: Pick<AccountFeatureService, "refresh" | "dispose">,
  windows: () => Iterable<BrowserWindow>,
) {
  app.on("browser-window-focus", (_event, window) => {
    if ([...windows()].includes(window)) void service.refresh(undefined, 60_000);
  });
  void app.whenReady().then(() => service.refresh());
  app.once("before-quit", () => service.dispose());
}
export function accountLocalConditions(
  status: CloudAccountStatus,
  relay: DesktopRelayStatus,
): ResolveAccountFeaturesInput["local"] {
  const matches =
    status.state === "signed-in" &&
    !!status.origin &&
    !!status.account &&
    relay.relayOrigin === status.origin &&
    relay.accountId === status.account.id;
  const registered = matches && relay.registered;
  const dispatch = registered && relay.state === "ready";
  const reason =
    relay.state === "storage-error"
      ? "storage_error"
      : !registered
        ? "device_not_registered"
        : relay.state === "connecting"
          ? "relay_connecting"
          : "relay_disconnected";
  return {
    "devices.dispatch": { ready: dispatch, reason },
    "devices.handoff": { ready: dispatch, reason },
    "relay.phone": { ready: registered, reason },
  };
}
export function registerAccountFeatureIpc(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  service: AccountFeatureService;
  windows: () => Iterable<BrowserWindow>;
}) {
  const owner = (event: IpcMainInvokeEvent) => {
    if (
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      ![...options.windows()].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      )
    )
      throw new Error("账号功能仅允许桌面主窗口访问。");
  };
  options.ipcMain.handle("accountFeatures:snapshot", (event) => {
    owner(event);
    return options.service.snapshot();
  });
  options.ipcMain.handle("accountFeatures:refresh", (event, origin?: string) => {
    owner(event);
    return options.service.refresh(origin);
  });
  const unsubscribe = options.service.onChanged((snapshot) => {
    for (const window of options.windows())
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("accountFeatures:changed", snapshot);
  });
  return {
    dispose() {
      unsubscribe();
      options.ipcMain.removeHandler("accountFeatures:snapshot");
      options.ipcMain.removeHandler("accountFeatures:refresh");
    },
  };
}
