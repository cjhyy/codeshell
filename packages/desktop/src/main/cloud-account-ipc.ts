import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { CloudAccountLogin } from "../shared/cloud-account.js";
import { accountGitHubRequest, accountLinksRequest } from "./cloud-account-links.js";
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
  options.ipcMain.handle("cloudAccount:capabilities", (event, origin: string) => {
    owner(event);
    return options.manager.capabilities(origin);
  });
  options.ipcMain.handle("cloudAccount:login", (event, input: CloudAccountLogin) => {
    owner(event);
    return options.manager.signIn("login", input, () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:register", (event, input: CloudAccountLogin) => {
    owner(event);
    return options.manager.signIn("register", input, () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:github", (event, raw: unknown) => {
    owner(event);
    const input = accountGitHubRequest(raw);
    return input.mode === "link"
      ? options.manager.linkGitHub(() => allowed(event))
      : options.manager.signInWithGitHub(input.input, () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:links", (event, raw: unknown) => {
    owner(event);
    return options.manager.manageLinks(accountLinksRequest(raw), () => allowed(event));
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
