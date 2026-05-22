/**
 * Electron main — boots a BrowserWindow and loads the renderer.
 *
 * What this file does NOT do yet:
 *   - instantiate Engine / AgentServer
 *   - bridge ipcMain to AgentServer.handleMessage
 *   - send stream events back to renderer
 *
 * Why: the renderer is a thin client by design — it talks to main only
 * over `window.codeShell.*` (preload-exposed named methods). The full
 * bridge needs:
 *   1. The monorepo split (@cjhyy/code-shell-core as its own package)
 *      so we can `import { Engine, AgentServer } from "@cjhyy/code-shell-core"`
 *      cleanly, without esbuild having to bundle all of root src/ from
 *      a relative path.
 *   2. preload to expose the codex-style named RPC surface
 *      (run / cancel / approve / onStream / ...).
 *
 * Until then, this file is intentionally minimal: enough Electron
 * scaffolding to prove the dev orchestrator (vite + esbuild + electron
 * launcher in scripts/dev.ts) is wired correctly. Opening the window
 * IS the milestone for this checkpoint.
 */

import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VITE_DEV_URL = process.env.VITE_DEV_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "code-shell",
    backgroundColor: "#1a1a1c",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (VITE_DEV_URL) {
    void win.loadURL(VITE_DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
