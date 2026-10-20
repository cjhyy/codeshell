import { Menu, MenuItem, app, BrowserWindow } from "electron";
import { loadRecents } from "./recents-store.js";

/** The project registry whose changes rewrite recents.json. */
export interface AppMenuRecentsSource {
  onChanged(listener: () => void): () => void;
}

/** The window that last installed the menu; only a fallback target. */
let installingWindow: BrowserWindow | null = null;
let recentsSubscribed = false;

/**
 * The application menu is shared by every window, so an action targets the
 * window Electron reports as focused for the click, not the window whose
 * creation last installed the menu.
 */
function sendToFocusedWindow(
  focused: Electron.BaseWindow | undefined,
  channel: string,
  ...args: unknown[]
): void {
  const candidates = [focused, BrowserWindow.getFocusedWindow(), installingWindow];
  const target = candidates.find(
    (candidate): candidate is BrowserWindow =>
      !!candidate && "webContents" in candidate && !candidate.isDestroyed(),
  );
  target?.webContents.send(channel, ...args);
}

/**
 * Build and install the app menu, including a dynamic "最近项目"
 * submenu populated from recents.json on each rebuild.
 *
 * Call `installAppMenu()` after window create. With a recents source the
 * menu also rebuilds whenever the project registry (and so recents) changes.
 */
export async function installAppMenu(
  win: BrowserWindow,
  recentsSource?: AppMenuRecentsSource,
): Promise<void> {
  installingWindow = win;
  if (recentsSource && !recentsSubscribed) {
    recentsSubscribed = true;
    recentsSource.onChanged(() => {
      if (installingWindow) void installAppMenu(installingWindow);
    });
  }
  const isMac = process.platform === "darwin";
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const recents = await loadRecents();

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        {
          label: "新窗口",
          accelerator: "CmdOrCtrl+Shift+N",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:new-window");
          },
        },
        {
          label: "添加项目…",
          accelerator: "CmdOrCtrl+O",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:add-project");
          },
        },
        {
          label: "最近项目",
          submenu:
            recents.length === 0
              ? [{ label: "(空)", enabled: false }]
              : recents.map((r) => ({
                  label: r.name,
                  sublabel: r.path,
                  click: (_item, focused) => {
                    sendToFocusedWindow(focused, "menu:open-recent", r);
                  },
                })),
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "查找…",
          accelerator: "CmdOrCtrl+F",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:find");
          },
        },
      ],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "命令面板…",
          accelerator: "CmdOrCtrl+K",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:palette");
          },
        },
        {
          label: "切换 侧栏",
          accelerator: "CmdOrCtrl+B",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:toggle-sidebar");
          },
        },
        {
          label: "查看当前会话的模型调用",
          accelerator: "CmdOrCtrl+I",
          click: (_item, focused) => {
            sendToFocusedWindow(focused, "menu:toggle-inspector");
          },
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/** Convenience for code paths that just want to add one recent item then refresh. */
export async function refreshAppMenu(win: BrowserWindow): Promise<void> {
  await installAppMenu(win);
}

// Quieting unused import warning for cases where MenuItem isn't directly used.
void MenuItem;
