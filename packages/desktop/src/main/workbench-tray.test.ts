import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

const fixturePlatform = process.env.CODESHELL_TRAY_FIXTURE;
if (fixturePlatform) {
  // Electron menus are process-wide. Exercise each platform in a child, so
  // neither its platform override nor its Electron mock leaks across suites.
  Object.defineProperty(process, "platform", { value: fixturePlatform });
  type Item = { label?: string; accelerator?: string; submenu?: Item[]; click?: () => void };
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => "/app.asar",
    getLocale: () => (fixturePlatform === "win32" ? "zh-CN" : "en-US"),
    quit: mock(() => {}),
  });
  let failTray = false;
  const created: FakeTray[] = [];
  class FakeTray extends EventEmitter {
    menu: Item[] = [];
    destroyed = false;
    constructor() {
      super();
      if (failTray) throw new Error("No notification area");
      created.push(this);
    }
    setToolTip() {}
    setContextMenu(menu: Item[]) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const createFromPath = mock(() => ({ isEmpty: () => false, resize: () => ({}) }));
  const setApplicationMenu = mock(() => {});
  mock.module("electron", () => ({
    app,
    Menu: { buildFromTemplate: (items: Item[]) => items, setApplicationMenu },
    nativeImage: { createFromPath },
    Tray: FakeTray,
  }));
  mock.module("./desktop-logger.js", () => ({ dlog: () => {} }));
  const { disposeWorkbenchTray, installWorkbenchTray, installWorkbenchQuitMenu } =
    await import("./workbench-tray.js");
  test("restores the window, quits normally and keeps a window menu if the tray fails", async () => {
    const focused: string[] = [];
    const workbench = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => focused.push("restore"),
      show: () => focused.push("show"),
      focus: () => focused.push("focus"),
      setMenu: mock((_menu: Item[]) => {}),
      setAutoHideMenuBar: mock((_v: boolean) => {}),
      setMenuBarVisibility: mock((_v: boolean) => {}),
    };
    const restore = mock(async () => workbench as never);
    installWorkbenchTray(restore);
    if (fixturePlatform === "darwin") {
      expect(setApplicationMenu).not.toHaveBeenCalled();
      expect(createFromPath).not.toHaveBeenCalled();
      return;
    }
    expect(createFromPath).toHaveBeenCalledWith(join("/app.asar", "build", "icon.png"));
    expect(setApplicationMenu).toHaveBeenCalledWith(null);
    const first = created[0];
    installWorkbenchTray(restore);
    expect(created).toHaveLength(1);
    const [show, , quit] = first.menu;
    expect(show.label).toBe(fixturePlatform === "win32" ? "显示 CodeShell" : "Show CodeShell");
    first.emit("click");
    show.click!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(restore).toHaveBeenCalledTimes(2);
    expect(focused).toEqual(["restore", "show", "focus", "restore", "show", "focus"]);
    quit.click!();
    expect(app.quit).toHaveBeenCalledTimes(1);
    installWorkbenchQuitMenu(workbench as never);
    expect(workbench.setMenu).toHaveBeenCalledTimes(1);
    expect(workbench.setAutoHideMenuBar).not.toHaveBeenCalled();
    disposeWorkbenchTray();
    first.emit("click");
    expect(restore).toHaveBeenCalledTimes(2);
    expect(first.destroyed).toBe(true);

    failTray = true;
    installWorkbenchTray(restore);
    installWorkbenchQuitMenu(workbench as never);
    expect(workbench.setAutoHideMenuBar).toHaveBeenCalledWith(false);
    expect(workbench.setMenuBarVisibility).toHaveBeenCalledWith(true);
    const quitItem = workbench.setMenu.mock.lastCall![0][0].submenu![0];
    expect(quitItem.label).toBe(quit.label);
    expect(quitItem.accelerator).toBe("Ctrl+Q");
    quitItem.click!();
    expect(app.quit).toHaveBeenCalledTimes(2);
  });
} else {
  test.each(["win32", "linux", "darwin"])("workbench tray lifecycle (%s)", async (platform) => {
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, CODESHELL_TRAY_FIXTURE: platform },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, stdout, exit] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(stdout + stderr);
    expect(stdout + stderr).toMatch(/\b1 pass\b/);
  });
}
