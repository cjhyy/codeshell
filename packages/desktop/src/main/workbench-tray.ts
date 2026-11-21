import { join } from "node:path";
import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import { dlog } from "./desktop-logger.js";
import { nativeMenuLanguage } from "./native-menu-language.js";
import { focusWorkbench } from "./quick-chat-startup-cleanup.js";

const labels = {
  zh: { show: "显示 CodeShell", quit: "退出 CodeShell" },
  en: { show: "Show CodeShell", quit: "Quit CodeShell" },
};

let tray: Tray | undefined;

function quitMenuItem(): Electron.MenuItemConstructorOptions {
  return { label: labels[nativeMenuLanguage(app.getLocale())].quit, click: () => app.quit() };
}

/** Keep the background Host reachable after the last Windows/Linux workbench closes. */
export function installWorkbenchTray(restoreMainWindow: () => Promise<BrowserWindow>): void {
  if (process.platform === "darwin" || tray) return;
  // Suppress Electron's default menu for utility windows. Each trusted
  // workbench installs its own Quit item, including when tray setup fails.
  Menu.setApplicationMenu(null);
  const show = () => {
    if (!tray) return;
    void restoreMainWindow()
      .then((win) => {
        if (tray) focusWorkbench(win);
      })
      .catch((error) => {
        dlog("main", "window.restore_failed", { error: String(error) });
      });
  };
  try {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), "build", "icon.png"));
    if (icon.isEmpty()) throw new Error("Missing workbench tray icon");
    tray = new Tray(icon.resize({ width: 32, height: 32 }));
    tray.setToolTip("CodeShell");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels[nativeMenuLanguage(app.getLocale())].show, click: show },
        { type: "separator" },
        quitMenuItem(),
      ]),
    );
    tray.on("click", show);
  } catch (error) {
    disposeWorkbenchTray();
    dlog("main", "workbench.tray_unavailable", { error: String(error) });
  }
}

/** Disposal starts after the save step, when quitting can no longer be cancelled. */
export function disposeWorkbenchTray(): void {
  tray?.destroy();
  tray = undefined;
}

export function installWorkbenchQuitMenu(win: BrowserWindow): void {
  win.setMenu(
    Menu.buildFromTemplate([
      { label: "&CodeShell", submenu: [{ ...quitMenuItem(), accelerator: "Ctrl+Q" }] },
    ]),
  );
  if (!tray) {
    win.setAutoHideMenuBar(false);
    win.setMenuBarVisibility(true);
  }
}
