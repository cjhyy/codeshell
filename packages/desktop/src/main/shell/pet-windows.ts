import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import { dlog } from "../desktop-logger.js";
import { shouldSkipPetWidgetTaskbar } from "../pet/pet-widget-window-state.js";

export function createPetWindows(
  mainDirectory: string,
  navigation: Pick<AppRendererNavigation, "bind">,
  attach: (win: BrowserWindow) => void,
) {
  /** Build the hidden docked-widget window; the surface decides when it shows. */
  function createPetWidgetBrowserWindow(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): BrowserWindow {
    const win = new BrowserWindow({
      ...bounds,
      // An ordinary NSWindow of a regular app is not drawn over another app's
      // fullscreen Space, so the docked pet vanished on any display showing one
      // (multi-display acceptance 2026-11-02). A panel joins those Spaces, like
      // the moving form; its inline chat still takes keyboard focus on click.
      ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // macOS owns one Dock icon per application, not per BrowserWindow. Setting
      // skipTaskbar on the Pet would hide CodeShell itself from the Dock.
      skipTaskbar: shouldSkipPetWidgetTaskbar(process.platform),
      alwaysOnTop: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: resolve(mainDirectory, "..", "preload", "index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep the pet animation and live activity state responsive while
        // CodeShell itself is behind another application.
        backgroundThrottling: false,
      },
    });
    // Register the widget window with the agent bridge so it receives live
    // agent:msg / agent:streamEvent broadcasts. Without this the widget's chat
    // only updates on a fresh transcript hydrate (opening the panel or a restart)
    // — the in-place reply never streams in. attachWindow self-removes on close,
    // so re-creating the widget re-attaches cleanly.
    attach(win);
    if (process.platform === "darwin") {
      void app.dock?.show();
      win.setHiddenInMissionControl(true);
    }
    try {
      // The panel needs no process-type round trip (UIElement and back) to join
      // fullscreen Spaces; skipping it also keeps the Dock icon from flickering.
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } catch {
      // Some Linux window managers do not implement workspace pinning.
    }
    navigation.bind(win.webContents);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("did-fail-load", (_event, code, desc, validatedUrl) => {
      dlog("main", "pet-widget.did-fail-load", { code, desc, validatedUrl });
    });
    win.webContents.on("console-message", ({ level, message, lineNumber: line, sourceId }) => {
      if (level === "warning" || level === "error")
        dlog("main", "pet-widget.console", { level, message, line, sourceId });
    });
    return win;
  }

  async function loadPetWidgetBrowserWindow(win: BrowserWindow, role?: "bubble"): Promise<void> {
    const query: Record<string, string> = { popout: "pet", ...(role ? { role } : {}) };
    const devUrl = process.env.VITE_DEV_URL;
    if (devUrl) {
      const url = new URL(devUrl);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(resolve(mainDirectory, "..", "renderer", "index.html"), { query });
    }
  }

  return { create: createPetWidgetBrowserWindow, load: loadPetWidgetBrowserWindow };
}
