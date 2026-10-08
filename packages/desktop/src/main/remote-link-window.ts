import { BrowserWindow, session, type Session } from "electron";
import { randomUUID } from "node:crypto";
import type { NativeLinkAuthorizationInput } from "./remote-link-manager.js";
import { createNativeLinkNavigationPolicy } from "./remote-link-navigation.js";

const authorizationSessions = new Map<string, Session>();

/** Remember the Link login for this app session without persisting cookies to disk. */
function authorizationSession(issuer: string): Session {
  const existing = authorizationSessions.get(issuer);
  if (existing) return existing;
  const browserSession = session.fromPartition(`codeshell-link-auth-${randomUUID()}`);
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.on("will-download", (event) => event.preventDefault());
  authorizationSessions.set(issuer, browserSession);
  return browserSession;
}

/** The Link login has no local bridge. Intercept its registered callback before any network request. */
export function openNativeLinkAuthorization(input: NativeLinkAuthorizationInput) {
  let callbackReceived = false;
  const issuer = new URL(input.authorizationUrl).origin;
  const navigation = createNativeLinkNavigationPolicy(input.authorizationUrl, input.redirectUri);
  const browserSession = authorizationSession(issuer);
  const window = new BrowserWindow({
    width: 660,
    height: 800,
    minWidth: 390,
    minHeight: 540,
    title: `连接 GitHub · ${new URL(issuer).host}`,
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
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const navigate = (event: Electron.Event, target: string, mainFrame: boolean) => {
    const action = navigation(target, mainFrame);
    if (action === "callback") {
      event.preventDefault();
      callbackReceived = true;
      input.onCallback(target);
    } else if (action === "deny") event.preventDefault();
  };
  window.webContents.on("will-frame-navigate", (event) =>
    navigate(event, event.url, event.isMainFrame),
  );
  window.webContents.on("will-redirect", (event) => navigate(event, event.url, event.isMainFrame));
  window.once("closed", () => {
    input.onCancel();
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
