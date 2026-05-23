/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { dlog } from "./desktop-logger.js";
import {
  getGitStatus,
  getGitDiff,
  openExternal,
  revealInFinder,
} from "./desktop-services.js";
import { readSettings, writeSettings, type SettingsScope } from "./settings-service.js";
import { listSessions, deleteSession } from "./sessions-service.js";
import { tailLog, type LogBucket } from "./logs-service.js";
import { loadRecents, pushRecent } from "./recents-store.js";
import { loadWindowState, saveWindowState } from "./window-state-store.js";
import { getTrust, setTrust, type TrustLevel } from "./trust-store.js";
import { installAppMenu, refreshAppMenu } from "./menu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

dlog("main", "boot", { argv: process.argv, execPath: process.execPath, cwd: process.cwd() });

let bridge: AgentBridge | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const ws = await loadWindowState();

  mainWindow = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    x: ws.x,
    y: ws.y,
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true requires preload to be CommonJS without node APIs.
      // Our preload uses only ipcRenderer + contextBridge, which are both
      // safe under the sandbox. If preload ever needs Node APIs, that
      // logic must move into main.
      sandbox: true,
    },
  });

  if (ws.maximized) mainWindow.maximize();

  // Strict CSP. Inline styles are needed for highlight.js & some
  // markdown libs; everything else stays local. No remote scripts.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; " +
          "font-src 'self' data:; " +
          "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*; " +
          "object-src 'none'; " +
          "base-uri 'none'; " +
          "frame-ancestors 'none'",
        ],
      },
    });
  });

  // Route external link clicks through shell.openExternal; never
  // navigate the BrowserWindow itself away from the renderer.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.VITE_DEV_URL ?? "";
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "right" });
  } else {
    mainWindow.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: "right" });
    }
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    dlog("main", "renderer.did-fail-load", { code, desc, url });
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    dlog("main", "renderer.render-process-gone", { details });
  });
  mainWindow.webContents.on("preload-error", (_e, preloadPath, err) => {
    dlog("main", "renderer.preload-error", { preloadPath, message: err.message, stack: err.stack });
  });
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    dlog("renderer", "console", { level, message, line, sourceId });
  });

  // Persist window bounds + maximized on change.
  const persist = (): void => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    void saveWindowState({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      maximized: mainWindow.isMaximized(),
    });
  };
  mainWindow.on("close", persist);
  mainWindow.on("resize", persist);
  mainWindow.on("move", persist);

  bridge = new AgentBridge(mainWindow);

  await installAppMenu(mainWindow);
}

app.whenReady().then(() => {
  void createWindow();
});

ipcMain.handle("dialog:pickDir", async (): Promise<{ path: string; name: string } | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const path = res.filePaths[0];
  const result = { path, name: basename(path) };
  await pushRecent({ ...result, lastOpenedAt: Date.now() });
  if (mainWindow) void refreshAppMenu(mainWindow);
  return result;
});

ipcMain.handle("git:status", async (_e, cwd: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:status requires cwd");
  return getGitStatus(cwd);
});

ipcMain.handle("git:diff", async (_e, cwd: string, file?: string) => {
  if (typeof cwd !== "string" || !cwd) throw new Error("git:diff requires cwd");
  return getGitDiff(cwd, file);
});

ipcMain.handle("shell:openExternal", async (_e, url: string) => {
  if (typeof url !== "string") throw new Error("openExternal requires url");
  await openExternal(url);
});

ipcMain.handle("shell:revealInFinder", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("revealInFinder requires path");
  await revealInFinder(p);
});

ipcMain.handle("settings:get", async (_e, scope: SettingsScope, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  return readSettings(scope, cwd);
});

ipcMain.handle("settings:set", async (_e, scope: SettingsScope, patch: Record<string, unknown>, cwd?: string) => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
  if (!patch || typeof patch !== "object") throw new Error("patch must be object");
  await writeSettings(scope, patch, cwd);
});

ipcMain.handle("sessions:list", async () => listSessions());
ipcMain.handle("sessions:delete", async (_e, id: string) => {
  if (typeof id !== "string") throw new Error("session id required");
  await deleteSession(id);
});

ipcMain.handle("logs:tail", async (_e, bucket: LogBucket, lines?: number) => {
  if (bucket !== "ui-ink" && bucket !== "engine" && bucket !== "desktop") {
    throw new Error("invalid bucket");
  }
  return tailLog(bucket, lines);
});

ipcMain.handle("trust:get", async (_e, p: string) => {
  if (typeof p !== "string") throw new Error("trust:get requires path");
  return getTrust(p);
});

ipcMain.handle("trust:set", async (_e, p: string, level: TrustLevel) => {
  if (typeof p !== "string") throw new Error("trust:set requires path");
  if (level !== "trusted" && level !== "untrusted") throw new Error("invalid level");
  await setTrust(p, level);
});

ipcMain.handle("recents:list", async () => loadRecents());

ipcMain.handle("notify:show", async (_e, opts: { title: string; body?: string; subtitle?: string }) => {
  if (!opts || typeof opts.title !== "string") throw new Error("notify:show requires title");
  if (!Notification.isSupported()) return;
  new Notification(opts).show();
});

ipcMain.handle("badge:set", async (_e, count: number) => {
  if (typeof count !== "number") throw new Error("badge:set requires number");
  if (process.platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
  } else {
    app.setBadgeCount?.(count);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge?.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
