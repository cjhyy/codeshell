/**
 * Electron main entry — broker between renderer (ipcMain) and the
 * agent worker subprocess (stdio JSON-RPC). See agent-bridge.ts.
 */

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AgentBridge } from "./agent-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  } else {
    mainWindow.loadFile(resolve(__dirname, "..", "renderer", "index.html"));
  }

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
