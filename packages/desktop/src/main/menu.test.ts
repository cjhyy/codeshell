import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

interface FakeWindow {
  id: string;
  destroyed: boolean;
  sent: unknown[][];
  isDestroyed(): boolean;
  webContents: { send: (...args: unknown[]) => void };
}

function fakeWindow(id: string): FakeWindow {
  const win: FakeWindow = {
    id,
    destroyed: false,
    sent: [],
    isDestroyed: () => win.destroyed,
    webContents: { send: (...args: unknown[]) => win.sent.push(args) },
  };
  return win;
}

type Template = Array<{ label?: string; submenu?: Template; click?: (...args: unknown[]) => void }>;

if (process.env.CODESHELL_MENU_FIXTURE === "1") {
  // Electron's Menu is a process-wide singleton; keep the module mock inside
  // this isolated child process so no other suite sees it.
  let applicationMenu: { items: Template } | null = null;
  let focused: FakeWindow | null = null;
  let recents = [{ path: "/projects/a", name: "A", lastOpenedAt: 1 }];
  mock.module("electron", () => ({
    app: { name: "CodeShell" },
    MenuItem: class {},
    BrowserWindow: { getFocusedWindow: () => focused },
    Menu: {
      buildFromTemplate: (items: Template) => ({ items }),
      setApplicationMenu: (menu: { items: Template }) => {
        applicationMenu = menu;
      },
    },
  }));
  mock.module("./recents-store.js", () => ({ loadRecents: async () => structuredClone(recents) }));
  const { installAppMenu } = await import("./menu.js");

  const item = (path: string[]): NonNullable<Template[number]> => {
    let items = applicationMenu!.items;
    let found: Template[number] | undefined;
    for (const label of path) {
      found = items.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`menu item missing: ${path.join(" > ")}`);
      items = found.submenu ?? [];
    }
    return found!;
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("menu actions go to the focused window, not the last window that installed the menu", async () => {
    const a = fakeWindow("a");
    const b = fakeWindow("b");
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
    await installAppMenu(fakeWindow("c") as never, source);
    expect(item(["文件", "最近项目"]).submenu!.map((entry) => entry.label)).toEqual(["A"]);

    recents = [
      { path: "/projects/b", name: "B", lastOpenedAt: 2 },
      { path: "/projects/a", name: "A renamed", lastOpenedAt: 1 },
    ];
    notify!();
    await flush();

    expect(item(["文件", "最近项目"]).submenu!.map((entry) => entry.label)).toEqual([
      "B",
      "A renamed",
    ]);
  });
} else {
  test.skipIf(process.platform !== "darwin")(
    "app menu routing and recents pass in an isolated Electron fixture",
    async () => {
      const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, CODESHELL_MENU_FIXTURE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}\n${stderr}`;
      if (exitCode !== 0) throw new Error(output.trim());
      expect(output).toMatch(/\n\s*0 fail/);
      expect(Number(/\n\s*(\d+) pass/.exec(output)?.[1] ?? 0)).toBe(2);
    },
    30_000,
  );
}
