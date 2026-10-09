import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { CloudAccountLogin } from "../shared/cloud-account.js";
import type { CloudAccountManager } from "./cloud-account-manager.js";

export function registerCloudAccountIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  manager: CloudAccountManager;
  isMainWindow: (sender: WebContents) => boolean;
}) {
  const allowed = (event: IpcMainInvokeEvent) =>
    !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    options.isMainWindow(event.sender);
  const owner = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error("云账号只能由桌面主窗口管理。");
  };
  options.ipcMain.handle("cloudAccount:status", (event) => {
    owner(event);
    return options.manager.status();
  });
  for (const kind of ["login", "register"] as const)
    options.ipcMain.handle(`cloudAccount:${kind}`, (event, input: CloudAccountLogin) => {
      owner(event);
      return options.manager.signIn(kind, input, () => allowed(event));
    });
  options.ipcMain.handle(
    "cloudAccount:github",
    (event, input: { origin: string; deviceName?: string }) => {
      owner(event);
      return options.manager.signInWithGitHub(input, () => allowed(event));
    },
  );
  options.ipcMain.handle("cloudAccount:linkGitHub", (event) => {
    owner(event);
    return options.manager.linkGitHub(() => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:cancelSignIn", (event) => {
    owner(event);
    return options.manager.cancelSignIn();
  });
  options.ipcMain.handle("cloudAccount:logout", (event) => {
    owner(event);
    return options.manager.logout();
  });
}
