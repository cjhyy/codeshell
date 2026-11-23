import { EventEmitter } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, mock, test } from "bun:test";

type Template = Array<{
  label?: string;
  accelerator?: string;
  submenu?: Template;
  click?: (...args: unknown[]) => void;
}>;
interface FakeMenu {
  items: Template;
}

function fakeWindow() {
  const sent: unknown[][] = [];
  const actions: string[] = [];
  return {
    sent,
    actions,
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus"),
    webContents: { send: (...args: unknown[]) => sent.push(args) },
    setMenu: mock((_menu: FakeMenu) => {}),
    setAutoHideMenuBar: mock((_visible: boolean) => {}),
    setMenuBarVisibility: mock((_visible: boolean) => {}),
  };
}

const fixturePlatform = process.env.CODESHELL_MENU_FIXTURE;
if (fixturePlatform) {
  // Electron menus and the tray are process-wide. Each child runs the real
  // menu installation paths against the same Electron singleton for its OS.
  Object.defineProperty(process, "platform", { value: fixturePlatform });
  let focused: ReturnType<typeof fakeWindow> | undefined;
  let recents = [{ path: "/projects/a", name: "A", lastOpenedAt: 1 }];
  let applicationMenu: FakeMenu | null = null;
  const setApplicationMenu = mock((menu: FakeMenu | null) => {
    applicationMenu = menu;
  });
  const app = {
    name: "CodeShell",
    getAppPath: () => "/app.asar",
    getLocale: () => (fixturePlatform === "win32" ? "zh-CN" : "en-US"),
    quit: mock(() => {}),
  };
  const createFromPath = mock(() => ({ isEmpty: () => false, resize: () => ({}) }));
  let failTray = false;
  const created: FakeTray[] = [];
  class FakeTray extends EventEmitter {
    menu!: FakeMenu;
    destroyed = false;
    constructor() {
      super();
      if (failTray) throw new Error("No notification area");
      created.push(this);
    }
    setToolTip() {}
    setContextMenu(menu: FakeMenu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  mock.module("electron", () => ({
    app,
    BrowserWindow: { getFocusedWindow: () => focused },
    MenuItem: class {},
    Menu: { buildFromTemplate: (items: Template) => ({ items }), setApplicationMenu },
    nativeImage: { createFromPath },
    Tray: FakeTray,
  }));
  mock.module("./desktop-logger.js", () => ({ dlog: () => {} }));
  mock.module("./recents-store.js", () => ({ loadRecents: async () => structuredClone(recents) }));
  const { installAppMenu } = await import("./menu.js");
  const { installWorkbenchTray, disposeWorkbenchTray } = await import("./workbench-tray.js");
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  if (fixturePlatform === "darwin") {
    test("the Dock and application menu provide the native entry points", () => {
      installWorkbenchTray(async () => fakeWindow() as never);
      expect(setApplicationMenu).not.toHaveBeenCalled();
      expect(createFromPath).not.toHaveBeenCalled();
    });

    function item(path: string[]) {
      let items = applicationMenu!.items;
      let found: Template[number] | undefined;
      for (const label of path) {
        found = items.find((candidate) => candidate.label === label);
        if (!found) throw new Error(`menu item missing: ${path.join(" > ")}`);
        items = found.submenu ?? [];
      }
      return found!;
    }

    test("menu actions go to the focused window, not the last window that installed the menu", async () => {
      const a = fakeWindow();
      const b = fakeWindow();
      await installAppMenu(a as never);
      await installAppMenu(b as never);
      focused = a;
      item(["编辑", "查找…"]).click!({}, a, {});
      item(["视图", "命令面板…"]).click!({}, a, {});
      item(["视图", "切换 侧栏"]).click!({}, a, {});
      item(["文件", "最近项目", "A"]).click!({}, a, {});
      expect(a.sent.map(([channel]) => channel)).toEqual([
        "menu:find",
        "menu:palette",
        "menu:toggle-sidebar",
        "menu:open-recent",
      ]);
      expect(b.sent).toEqual([]);
    });

    test("the Recent Projects menu rebuilds when the project registry changes", async () => {
      let notify: (() => void) | undefined;
      const source = {
        onChanged: (listener: () => void) => {
          notify = listener;
          return () => {};
        },
      };
      await installAppMenu(fakeWindow() as never, source);
      expect(item(["文件", "最近项目"]).submenu!.map((entry) => entry.label)).toEqual(["A"]);
      recents = [
        { path: "/projects/b", name: "B", lastOpenedAt: 2 },
        { path: "/projects/a", name: "A renamed", lastOpenedAt: 1 },
      ];
      notify!();
      await tick();
      expect(item(["文件", "最近项目"]).submenu!.map((entry) => entry.label)).toEqual([
        "B",
        "A renamed",
      ]);
    });
  } else {
    test("tray and workbench menus restore the window and quit via the app", async () => {
      const win = fakeWindow();
      const restore = mock(async () => win as never);
      installWorkbenchTray(restore);
      installWorkbenchTray(restore);
      expect(created).toHaveLength(1);
      expect(createFromPath).toHaveBeenCalledWith(join("/app.asar", "build", "icon.png"));
      expect(setApplicationMenu).toHaveBeenCalledWith(null);
      const [show, , quit] = created[0].menu.items;
      expect(show.label).toBe(fixturePlatform === "win32" ? "显示 CodeShell" : "Show CodeShell");
      created[0].emit("click");
      show.click!();
      await tick();
      expect(restore).toHaveBeenCalledTimes(2);
      expect(win.actions).toEqual(["restore", "show", "focus", "restore", "show", "focus"]);
      quit.click!();
      expect(app.quit).toHaveBeenCalledTimes(1);
      await installAppMenu(win as never);
      expect(win.setMenu).toHaveBeenCalledTimes(1);
      expect(win.setAutoHideMenuBar).not.toHaveBeenCalled();
      disposeWorkbenchTray();
      created[0].emit("click");
      expect(restore).toHaveBeenCalledTimes(2);
      expect(created[0].destroyed).toBe(true);
    });

    test("if no tray is available, the visible workbench menu still quits normally", async () => {
      const win = fakeWindow();
      failTray = true;
      app.quit.mockClear();
      installWorkbenchTray(async () => win as never);
      await installAppMenu(win as never);
      expect(win.setAutoHideMenuBar).toHaveBeenCalledWith(false);
      expect(win.setMenuBarVisibility).toHaveBeenCalledWith(true);
      const quit = win.setMenu.mock.lastCall![0].items[0].submenu![0];
      expect(quit.label).toBe(fixturePlatform === "win32" ? "退出 CodeShell" : "Quit CodeShell");
      expect(quit.accelerator).toBe("Ctrl+Q");
      quit.click!();
      expect(app.quit).toHaveBeenCalledTimes(1);
    });
  }
} else {
  test.each(["win32", "linux", "darwin"])(
    "native workbench menus (%s)",
    async (platform) => {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, CODESHELL_MENU_FIXTURE: platform },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = stdout + stderr;
      if (exitCode !== 0) throw new Error(output.trim());
      expect(output).toMatch(/\b0 fail\b/);
      expect(Number(/\b(\d+) pass\b/.exec(output)?.[1])).toBe(platform === "darwin" ? 3 : 2);
    },
    30_000,
  );
}
