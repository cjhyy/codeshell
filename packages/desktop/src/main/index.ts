/**
 * Electron main process — owns the Engine + AgentServer and exposes them
 * to the renderer over a typed IPC channel.
 *
 * Flow per window:
 *   1. Spawn BrowserWindow with preload.
 *   2. Build an IpcTransport whose sink is webContents.send and whose
 *      subscribe wraps ipcMain.on. The renderer's IpcTransport (created
 *      in preload via contextBridge) mirrors this.
 *   3. Hand the transport to AgentServer(engine, transport). The server
 *      now answers RPC calls and streams events back to the renderer.
 *
 * Multiple windows = multiple Engine instances. Each gets its own
 * dedicated channel so RPC ids don't collide. State that's currently
 * still module-level (taskManager, permission backend, ...) is shared
 * across windows for now; that's tracked in a follow-up.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Engine } from "../../../../src/index.js";
import { AgentServer } from "../../../../src/protocol/server.js";
import {
  IpcTransport,
  type IpcSink,
  type IpcSubscribe,
} from "../../../../src/protocol/transport.js";
import type { RpcMessage } from "../../../../src/protocol/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RPC_FROM_RENDERER = "code-shell:rpc:to-main";
const RPC_TO_RENDERER = "code-shell:rpc:to-renderer";

interface WindowAttachment {
  win: BrowserWindow;
  transport: IpcTransport;
  server: AgentServer;
}

const attachments = new Map<number, WindowAttachment>();

function attachEngineToWindow(win: BrowserWindow): WindowAttachment {
  const wcId = win.webContents.id;

  const sink: IpcSink = (msg: RpcMessage) => {
    if (win.isDestroyed()) return;
    win.webContents.send(RPC_TO_RENDERER, msg);
  };

  const subscribe: IpcSubscribe = (handler) => {
    const listener = (
      event: Electron.IpcMainEvent,
      msg: RpcMessage,
    ): void => {
      if (event.sender.id !== wcId) return; // only this window's traffic
      handler(msg);
    };
    ipcMain.on(RPC_FROM_RENDERER, listener);
    return () => ipcMain.removeListener(RPC_FROM_RENDERER, listener);
  };

  const transport = new IpcTransport(sink, subscribe);

  // POC: minimal engine config. Real product would read settings, model
  // pool, etc. Defaults are fine for getting the round-trip working.
  const engine = new Engine({
    llm: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY ?? "",
    },
  });

  const server = new AgentServer(engine, transport);

  const attachment: WindowAttachment = { win, transport, server };
  attachments.set(wcId, attachment);

  win.on("closed", () => {
    transport.close();
    attachments.delete(wcId);
  });

  return attachment;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "code-shell",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Dev mode: electron-vite serves the renderer on a local HTTP port and
  // sets ELECTRON_RENDERER_URL. Production build: load the built HTML.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  attachEngineToWindow(win);
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
