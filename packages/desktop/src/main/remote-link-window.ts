import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import type { NativeLinkAuthorizationInput } from "./remote-link-manager.js";

/** The Link login has no local bridge. Intercept its registered callback before any network request. */
export function openNativeLinkAuthorization(input: NativeLinkAuthorizationInput) {
  let callbackReceived = false;
  const issuer = new URL(input.authorizationUrl).origin;
  const callback = new URL(input.redirectUri);
  const browserSession = session.fromPartition(`codeshell-link-auth-${randomUUID()}`);
  const window = new BrowserWindow({
    width: 660,
    height: 800,
    minWidth: 390,
    minHeight: 540,
    title: `Link 授权 · ${new URL(issuer).host}`,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.on("will-download", (event) => event.preventDefault());
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const navigate = (event: Electron.Event, target: string, mainFrame: boolean) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      event.preventDefault();
      return;
    }
    if (url.username || url.password) {
      event.preventDefault();
      return;
    }
    if (url.origin === callback.origin && url.pathname === callback.pathname) {
      event.preventDefault();
      if (mainFrame) {
        callbackReceived = true;
        input.onCallback(target);
      }
    } else if (url.origin !== issuer) event.preventDefault();
  };
  window.webContents.on("will-navigate", (event, target) => navigate(event, target, true));
  window.webContents.on("will-redirect", (event, target, _inPlace, mainFrame) =>
    navigate(event, target, mainFrame),
  );
  window.once("closed", () => {
    input.onCancel();
    void browserSession.clearStorageData().catch(() => {});
  });
  void window.loadURL(input.authorizationUrl).catch(() => {
    if (callbackReceived) return;
    input.onCancel();
    if (!window.isDestroyed()) window.destroy();
  });
  return {
    close: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
