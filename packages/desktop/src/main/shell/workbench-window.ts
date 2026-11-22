import {
  nativeMessagingOriginFromArgv,
  runChromeNativeMessagingHost,
} from "../browser-runtime/index.js";
import { registerPanelAppSchemePrivileges } from "../panel-app-protocol.js";
import {
  acquireDesktopInstanceLock,
  registerSecondInstanceFocus,
  createMainWindowRestorer,
} from "../quick-chat-startup-cleanup.js";
import { app, BrowserWindow, nativeTheme, session, type WebContents } from "electron";
import { resolve } from "node:path";
import { MEDIA_PREVIEW_SCHEME } from "../../shared/media-preview.js";
import { THEME_ASSET_SCHEME } from "../theme-asset-protocol.js";
import { mainWindowTitleBarOptions } from "../window-titlebar.js";
import { loadWindowState, saveWindowState } from "../window-state-store.js";
import { dlog } from "../desktop-logger.js";

/** Register schemes before Electron becomes ready, including in Chrome's native-messaging process. */
export function prepareNativeInstance(): boolean {
  const chromeNativeMessagingOrigin = nativeMessagingOriginFromArgv(process.argv);
  if (chromeNativeMessagingOrigin) {
    void runChromeNativeMessagingHost(chromeNativeMessagingOrigin)
      .then(() => app.exit(0))
      .catch((error) => {
        process.stderr.write(`[codeshell chrome native host] ${String(error)}\n`);
        app.exit(1);
      });
  }

  // Electron accepts privileged custom schemes in one pre-ready registration.
  // The request handlers are installed later on their respective sessions.
  registerPanelAppSchemePrivileges();

  // Override the runtime app name. In dev (`electron .`) the default is
  // "Electron"; this makes the macOS menu bar, Dock tooltip, and About
  // panel show our product name even before packaging. setAppUserModelId
  // makes Windows taskbar/notification grouping work correctly.
  app.setName("code-shell");
  if (process.platform === "win32") app.setAppUserModelId("com.cjhyy.codeshell");
  return Boolean(chromeNativeMessagingOrigin);
}

export function bindWorkbenchInstance(
  chromeNativeMessaging: boolean,
  mainWindows: Set<BrowserWindow>,
  preferredMainWindow: () => BrowserWindow | null,
  createWindow: () => Promise<BrowserWindow>,
) {
  const ownsDesktopInstance = chromeNativeMessaging ? false : acquireDesktopInstanceLock(app);
  const restoreMainWindow = createMainWindowRestorer(preferredMainWindow, async () => {
    await app.whenReady();
    return createWindow();
  });
  if (ownsDesktopInstance) {
    registerSecondInstanceFocus(
      (handler) => app.on("second-instance", handler),
      () => Array.from(mainWindows),
      () => {
        void restoreMainWindow().catch((error) =>
          dlog("main", "window.restore_failed", { error: String(error) }),
        );
      },
    );
  }
  return { ownsDesktopInstance, restoreMainWindow };
}

let cspInstalled = false;

function sendWindowFullscreenState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send("window:fullscreen", { fullscreen: win.isFullScreen() });
}

export async function createWorkbenchSurface(
  mainDirectory: string,
  deps: {
    mainWindows: Set<BrowserWindow>;
    hardenGuests(win: BrowserWindow): void;
    bind(contents: WebContents): void;
    releaseDocumentAccess(ownerId: number): void;
    ownedSessionIds(ownerId: number): Iterable<string>;
    releaseWindow(ownerId: number, windowId: number): void;
    lastNonMacWindowClosed(): void;
  },
) {
  const ws = await loadWindowState();

  const win = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    icon: resolve(mainDirectory, "..", "..", "build", "icon.png"),
    // macOS retains its traffic lights; Windows overlays native caption
    // buttons on the themed header instead of adding a second system bar.
    ...mainWindowTitleBarOptions(process.platform, nativeTheme.shouldUseDarkColors),
    // Windows/Linux: hide the native menu bar (文件/编辑/视图) by default so it
    // doesn't clutter the window — it looked out of place jammed inside the
    // frame (macOS has a global menu bar; win/linux render it in-window). Still
    // reachable via Alt, and every item also has a shortcut / in-app affordance.
    // No-op on macOS (global menu bar, not in-window).
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: resolve(mainDirectory, "..", "preload", "index.cjs"),
      additionalArguments: [
        "--codeshell-desktop-host",
        ...(process.platform === "win32" ? ["--codeshell-titlebar-overlay"] : []),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enable <webview> for the built-in browser panel. The guest runs in its
      // own process/partition; we harden its webPreferences on attach below.
      webviewTag: true,
    },
  });
  deps.mainWindows.add(win);

  // Harden the browser-panel <webview> guests for THIS window (main + popout
  // both host a BrowserPanel, so both need it — without it on the popout the
  // guest fell into defaultSession and inherited our renderer CSP, refusing the
  // site's own /_next/static fonts).
  deps.hardenGuests(win);

  if (ws.maximized) win.maximize();

  // CSP installed once on the default session (sessions are shared
  // across windows, so re-installing per window would double-emit).
  //
  // Dev needs `'unsafe-inline'` for scripts because Vite's React plugin
  // injects an inline preamble for Fast Refresh — without it the
  // renderer fails to start. Dev also needs `connect-src ws://…` for
  // HMR and `style-src 'unsafe-inline'` for vite's style injection.
  //
  // Prod tightens script-src back to 'self'. Inline styles stay
  // permitted (highlight.js / react-markdown emit them).
  if (!cspInstalled) {
    cspInstalled = true;
    const isDev = Boolean(process.env.VITE_DEV_URL);
    const csp = isDev
      ? [
          // Vite HMR reconnects through a SharedWorker whose script is a
          // blob: URL. CSP's worker-src has no separate dev exception, so
          // we list blob: under script-src (worker-src falls back to it)
          // and add an explicit worker-src for clarity.
          "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
            "worker-src 'self' blob:; " +
            "style-src 'self' 'unsafe-inline'; " +
            `img-src 'self' data: blob: ${THEME_ASSET_SCHEME}:; ` +
            `media-src 'self' blob: ${THEME_ASSET_SCHEME}: ${MEDIA_PREVIEW_SCHEME}:; ` +
            "font-src 'self' data:; " +
            "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-ancestors 'none'",
        ]
      : [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "worker-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            `img-src 'self' data: ${THEME_ASSET_SCHEME}:; ` +
            `media-src 'self' blob: ${THEME_ASSET_SCHEME}: ${MEDIA_PREVIEW_SCHEME}:; ` +
            "font-src 'self' data:; " +
            // localhost connect is needed by the browser panel's dev-server
            // probe; without it the prod build can never detect local servers.
            "connect-src 'self' http://localhost:* http://127.0.0.1:*; " +
            "object-src 'none'; " +
            "base-uri 'none'; " +
            "frame-ancestors 'none'",
        ];
    // This CSP describes the *app's own* renderer (origin = the Vite dev URL
    // in dev, or file: in prod). The browser panel's <webview> guests live in
    // the "persist:browser" partition and load arbitrary external sites — they
    // must keep their OWN headers, or e.g. a Next.js site's self-hosted
    // /_next/static/media/*.woff2 fonts get refused against our `font-src
    // 'self' data:`. So scope the override to renderer-origin requests only.
    const rendererOrigin = process.env.VITE_DEV_URL ?? "";
    const isRendererRequest = (url: string): boolean =>
      url.startsWith("file://") ||
      (rendererOrigin !== "" && url.startsWith(rendererOrigin)) ||
      url.startsWith("devtools://");
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      if (!isRendererRequest(details.url)) {
        cb({ responseHeaders: details.responseHeaders });
        return;
      }
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": csp,
        },
      });
    });

    // Voice input (听写) needs microphone access via getUserMedia. Electron
    // denies media by default unless a handler grants it. Allow ONLY `media`,
    // and ONLY for our own renderer (the file:/dev-URL origin); deny everything
    // else — keeps the secure default while enabling the mic. The browser-panel
    // <webview> guests live in the separate "persist:browser" partition, so this
    // defaultSession handler does not touch their permissions.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      // Allow ONLY for our own renderer (the file:/dev-URL origin); deny
      // everything else. `media` enables the mic. `clipboard-sanitized-write`
      // is what `navigator.clipboard.writeText` requests under the dev server's
      // http://localhost origin — without granting it, the copy buttons throw
      // `NotAllowedError: Write permission denied` (the file:// prod origin
      // skips the request, so this only bites in dev).
      if (permission === "media" || permission === "clipboard-sanitized-write") {
        cb(isRendererRequest(wc.getURL()));
        return;
      }
      cb(false);
    });
  }

  deps.bind(win.webContents);
  const ownerId = win.webContents.id;
  const windowId = win.id;
  const releaseDocumentAccess = () => deps.releaseDocumentAccess(ownerId);
  win.webContents.once("destroyed", releaseDocumentAccess);
  win.webContents.on("render-process-gone", releaseDocumentAccess);
  win.webContents.on("did-start-navigation", (navigation) => {
    if (navigation.isMainFrame && !navigation.isSameDocument) releaseDocumentAccess();
  });
  win.webContents.on("did-finish-load", () => {
    for (const sessionId of deps.ownedSessionIds(ownerId))
      win.webContents.send("externalRuntime:sessionState", { sessionId, active: true });
  });
  win.on("closed", () => {
    deps.mainWindows.delete(win);
    deps.releaseWindow(ownerId, windowId);
    if (process.platform !== "darwin" && deps.mainWindows.size === 0) deps.lastNonMacWindowClosed();
  });

  const devUrl = process.env.VITE_DEV_URL;
  const noDevtools = process.env.CODE_SHELL_NO_DEVTOOLS === "1";
  const loadRenderer = () => {
    if (devUrl) {
      void win.loadURL(devUrl);
      if (!noDevtools) win.webContents.openDevTools({ mode: "right" });
    } else {
      void win.loadFile(resolve(mainDirectory, "..", "renderer", "index.html"));
      if (!app.isPackaged && !noDevtools) win.webContents.openDevTools({ mode: "right" });
    }
  };

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    dlog("main", "renderer.did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    dlog("main", "renderer.render-process-gone", { details });
  });
  win.webContents.on("preload-error", (_e, preloadPath, err) => {
    dlog("main", "renderer.preload-error", { preloadPath, message: err.message, stack: err.stack });
  });
  win.webContents.on("console-message", ({ level, message, lineNumber: line, sourceId }) => {
    dlog("renderer", "console", { level, message, line, sourceId });
  });
  win.webContents.on("did-finish-load", () => sendWindowFullscreenState(win));

  const persist = (): void => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    void saveWindowState({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: win.isMaximized(),
    });
  };
  win.on("close", persist);
  win.on("resize", persist);
  win.on("move", persist);
  win.on("enter-full-screen", () => sendWindowFullscreenState(win));
  win.on("leave-full-screen", () => sendWindowFullscreenState(win));
  return { win, loadRenderer };
}
