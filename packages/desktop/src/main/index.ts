/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { dlog } from "./desktop-logger.js";

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge?.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
