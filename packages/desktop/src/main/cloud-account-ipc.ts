import { accountRegistrationUrl } from "@cjhyy/code-shell-web/account";
import { hostname } from "node:os";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { CloudAccountBrowserLogin, CloudAccountLogin } from "../shared/cloud-account.js";
import { accountGitHubRequest, accountLinksRequest } from "./cloud-account-links.js";
import type { CloudAccountManager } from "./cloud-account-manager.js";
import { accountProfileRequest } from "./cloud-account-profile.js";

export function registerCloudAccountIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  manager: CloudAccountManager;
  openExternal?: (url: string) => Promise<void>;
  isMainWindow: (sender: WebContents) => boolean;
  focusMainWindow?: (sender: WebContents) => void;
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
  options.ipcMain.handle("cloudAccount:resume", (event) => {
    owner(event);
    return options.manager.resume(() => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:capabilities", (event, origin: string) => {
    owner(event);
    return options.manager.capabilities(origin);
  });
  options.ipcMain.handle("cloudAccount:login", (event, input: CloudAccountLogin) => {
    owner(event);
    return options.manager.signIn("login", input, () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:openRegistration", (event, origin: string) => {
    owner(event);
    const url = accountRegistrationUrl(origin);
    return (async () => {
      const capabilities = await options.manager.capabilities(origin);
      owner(event);
      if (!capabilities.registrationAllowed) throw new Error("此账号服务暂未开放注册。");
      if (!options.openExternal) throw new Error("网页注册入口暂不可用。");
      await options.openExternal(url);
    })();
  });
  options.ipcMain.handle("cloudAccount:openManagement", (event, section: unknown) => {
    owner(event);
    if (
      typeof section !== "string" ||
      !["profile", "security", "sessions", "connections"].includes(section)
    )
      throw new Error("账号管理页面无效。");
    const status = options.manager.status();
    if (status.state !== "signed-in" || !status.account || !status.origin)
      throw new Error("请先登录云账号。");
    // Reuse the exact HTTPS origin validation; no account credential is placed in a browser URL.
    const origin = new URL(accountRegistrationUrl(status.origin)).origin;
    if (!options.openExternal) throw new Error("网页账号管理入口暂不可用。");
    return options.openExternal(`${origin}/settings/account/${section}`);
  });
  options.ipcMain.handle("cloudAccount:browser", (event, input: CloudAccountBrowserLogin) => {
    owner(event);
    return options.manager
      .signInWithBrowser({ ...input, deviceName: hostname().slice(0, 100) }, () => allowed(event))
      .then((status) => {
        if (status.state === "signed-in" && allowed(event)) {
          try {
            options.focusMainWindow?.(event.sender);
          } catch {
            /* Login is already saved. */
          }
        }
        return status;
      });
  });
  options.ipcMain.handle("cloudAccount:register", (event, input: CloudAccountLogin) => {
    owner(event);
    return options.manager.signIn("register", input, () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:github", (event, raw: unknown) => {
    owner(event);
    const input = accountGitHubRequest(raw);
    const operation =
      input.mode === "link"
        ? options.manager.linkGitHub(() => allowed(event))
        : options.manager.signInWithGitHub(input.input, () => allowed(event));
    return operation.then((status) => {
      // Combined sign-in still needs the browser for Link repository/action consent.
      if (status.state === "signed-in" && status.githubConnection?.state !== "pending") {
        try {
          if (allowed(event)) options.focusMainWindow?.(event.sender);
        } catch {
          // Window disposal or a focus failure must not change a completed login.
        }
      }
      return status;
    });
  });
  options.ipcMain.handle("cloudAccount:links", (event, raw: unknown) => {
    owner(event);
    return options.manager.manageLinks(accountLinksRequest(raw), () => allowed(event));
  });
  options.ipcMain.handle("cloudAccount:profile", (event, raw: unknown) => {
    owner(event);
    return options.manager.profile(accountProfileRequest(raw), () => allowed(event));
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
