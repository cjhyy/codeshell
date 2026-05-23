/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

dlog("main", "boot", { argv: process.argv, execPath: process.execPath, cwd: process.cwd() });

let bridge: AgentBridge | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: resolve(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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

  bridge = new AgentBridge(mainWindow);
}

app.whenReady().then(createWindow);

ipcMain.handle("dialog:pickDir", async (): Promise<{ path: string; name: string } | null> => {
  const res = await dialog.showOpenDialog({
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const path = res.filePaths[0];
  return { path, name: basename(path) };
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge?.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
