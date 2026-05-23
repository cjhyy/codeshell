import { Menu, MenuItem, app, BrowserWindow } from "electron";
import { loadRecents } from "./recents-store.js";

/**
 * Build and install the app menu, including a dynamic "最近项目"
 * submenu populated from recents.json on each rebuild.
 *
 * Call `installAppMenu()` after window create, and again any time
 * recents change (we re-read the file each call).
 */
export async function installAppMenu(win: BrowserWindow): Promise<void> {
  const recents = await loadRecents();
  const isMac = process.platform === "darwin";

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
          click: () => {
            win.webContents.send("menu:new-window");
          },
        },
        {
          label: "添加项目…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            win.webContents.send("menu:add-project");
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
                  click: () => {
                    win.webContents.send("menu:open-recent", r);
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
          click: () => {
            win.webContents.send("menu:find");
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
          click: () => {
            win.webContents.send("menu:palette");
          },
        },
        {
          label: "切换 侧栏",
          accelerator: "CmdOrCtrl+B",
          click: () => {
            win.webContents.send("menu:toggle-sidebar");
          },
        },
        {
          label: "切换 详情",
          accelerator: "CmdOrCtrl+I",
          click: () => {
            win.webContents.send("menu:toggle-inspector");
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
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
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
