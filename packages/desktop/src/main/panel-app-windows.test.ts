import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PanelAppWindows } from "./panel-app-windows";
import type { PanelAppWindowSource } from "./panel-app-bridge";

const target = { appDescriptorId: "panel-app:editor", tabId: "editor-2", bucket: "/repo::two" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Contents extends EventEmitter {
  destroyed = false;
  focused = 0;
  loaded: string[] = [];
  closeCalls = 0;
  windowOpenHandler?: () => { action: string };
  load: () => Promise<void> = async () => {};
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  setWindowOpenHandler(handler: () => { action: string }) {
    this.windowOpenHandler = handler;
  }
  focus() {
    this.focused++;
  }
  async loadURL(url: string) {
    this.loaded.push(url);
    await this.load();
  }
  close() {
    this.closeCalls++;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class NativeWindow extends EventEmitter {
  readonly webContents: Contents;
  destroyed = false;
  minimized = false;
  visible = false;
  focused = 0;
  menu: unknown;
  size = [1100, 800];
  view: any;
  contentView = { addChildView: (view: any) => (this.view = view) };
  constructor(readonly id: number) {
    super();
    this.webContents = new Contents(id * 10);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
    this.emit("restore");
  }
  show() {
    this.visible = true;
    this.emit("show");
  }
  focus() {
    this.focused++;
  }
  setMenu(menu: unknown) {
    this.menu = menu;
  }
  getContentSize() {
    return this.size;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

function fixture() {
  const source: PanelAppWindowSource = {
    guestId: 2,
    ownerWindowId: 1,
    descriptor: {
      id: target.appDescriptorId,
      appId: "editor",
      title: "Editor",
      version: "1.0.0",
      icon: "panel",
      singleton: true,
      permissions: ["context.session", "context.workspace", "storage"],
      hostId: "editor-host",
      revision: "version-one",
    },
    bindInput: {
      ...target,
      guestId: 2,
      sessionId: "session-two",
      projectPath: "/repo",
      cwd: "/repo",
      visible: true,
      theme: "dark",
      locale: "zh",
    },
  };
  const owner = new NativeWindow(1);
  const sender = owner.webContents;
  const windows: NativeWindow[] = [];
  const windowOptions: any[] = [];
  const views: any[] = [];
  const viewOptions: any[] = [];
  const registered: any[][] = [];
  const bindings: number[][] = [];
  const revoked: number[] = [];
  let changed = () => {};
  let revokeSource = () => {};
  let unsubscribed = 0;
  let prepare: () => Promise<any> = async () => ({
    id: target.appDescriptorId,
    src: "cspanel://editor-host/app/index.html",
    partition: "cspanel:editor:repo",
    revision: "version-one",
  });
  let load = async () => {};
  let bind = async () => true;
  const bridge = {
    getWindowSource: (actualSender: any, actualTarget: any) => {
      if (actualSender !== sender || JSON.stringify(actualTarget) !== JSON.stringify(target))
        throw new Error("untrusted source");
      return source;
    },
    subscribeWindowSource: (_id: number, onChanged: () => void, onRevoked: () => void) => {
      changed = onChanged;
      revokeSource = onRevoked;
      return () => unsubscribed++;
    },
    registerGuest: (...args: any[]) => registered.push(args),
    bindWindowGuest: async (guestId: number, sourceId: number) => {
      bindings.push([guestId, sourceId]);
      return bind();
    },
    revokeGuest: (id: number) => revoked.push(id),
  };
  const manager = new PanelAppWindows({
    bridge: bridge as any,
    prepare: () => prepare(),
    validateEntry: () => ({
      descriptor: source.descriptor,
      root: "/installed",
      entry: "app/index.html",
    }),
    ownerWindow: (id) => (id === 1 ? owner : null) as any,
    createWindow: (options) => {
      windowOptions.push(options);
      const win = new NativeWindow(windows.length + 10);
      windows.push(win);
      return win as any;
    },
    createView: (options) => {
      viewOptions.push(options);
      const contents = new Contents(views.length + 100);
      contents.load = () => load();
      const view = {
        webContents: contents,
        bounds: null,
        setBounds(bounds: unknown) {
          this.bounds = bounds;
        },
      };
      views.push(view);
      return view as any;
    },
    preloadPath: "/audited/panel-app.cjs",
  });
  return {
    source,
    sender,
    owner,
    manager,
    windows,
    windowOptions,
    views,
    viewOptions,
    registered,
    bindings,
    revoked,
    changed: () => changed(),
    revokeSource: () => revokeSource(),
    unsubscribed: () => unsubscribed,
    prepare: (fn: typeof prepare) => (prepare = fn),
    load: (fn: typeof load) => (load = fn),
    bind: (fn: typeof bind) => (bind = fn),
  };
}

test("Panel windows are scoped native views with only the Panel preload", async () => {
  const f = fixture();
  await f.manager.open(f.sender as any, target);
  expect(f.windows).toHaveLength(1);
  expect(f.registered[0]![1]).toBe(f.windows[0]);
  expect(f.registered[0]![3]).toBe("/repo");
  expect(f.bindings.every(([guest, source]) => guest === 100 && source === 2)).toBe(true);
  expect(f.windowOptions[0].webPreferences).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webviewTag: false,
    javascript: false,
  });
  expect(f.viewOptions[0].webPreferences).toMatchObject({
    preload: "/audited/panel-app.cjs",
    partition: "cspanel:editor:repo",
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
  });
  expect(f.windows[0]!.webContents.windowOpenHandler!()).toEqual({ action: "deny" });
  expect(f.views[0].webContents.loaded).toEqual(["cspanel://editor-host/app/index.html"]);
  expect(f.views[0].bounds).toEqual({ x: 0, y: 0, width: 1100, height: 800 });
  f.windows[0]!.size = [700, 500];
  f.windows[0]!.emit("resize");
  expect(f.views[0].bounds).toEqual({ x: 0, y: 0, width: 700, height: 500 });
  f.owner.destroy();
  expect(f.windows[0]!.destroyed).toBe(true);
  expect(f.views[0].webContents.closeCalls).toBe(1);
  expect(f.revoked).toEqual([100]);
  expect(f.unsubscribed()).toBe(1);
});

test("concurrent open requests share a window and repeat requests restore it", async () => {
  const f = fixture();
  const preparation = deferred<any>();
  f.prepare(() => preparation.promise);
  const first = f.manager.open(f.sender as any, target);
  const second = f.manager.open(f.sender as any, target);
  preparation.resolve({
    id: target.appDescriptorId,
    src: "cspanel://editor-host/app/index.html",
    partition: "cspanel:editor:repo",
    revision: "version-one",
  });
  await Promise.all([first, second]);
  expect(f.windows).toHaveLength(1);
  f.windows[0]!.minimized = true;
  await f.manager.open(f.sender as any, target);
  expect(f.windows).toHaveLength(1);
  expect(f.windows[0]!.minimized).toBe(false);
  expect(f.windows[0]!.focused).toBe(3);
  f.windows[0]!.destroy();
  await f.manager.open(f.sender as any, target);
  expect(f.windows).toHaveLength(2);
  f.owner.destroy();
});

test("source updates synchronize and source revocation closes only its derived guest", async () => {
  const f = fixture();
  await f.manager.open(f.sender as any, target);
  const before = f.bindings.length;
  f.changed();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.bindings.length).toBeGreaterThan(before);
  f.revokeSource();
  expect(f.windows[0]!.destroyed).toBe(true);
  expect(f.revoked).toEqual([100]);
  expect(f.sender.destroyed).toBe(false);
  expect(f.owner.listenerCount("closed")).toBe(0);
});

test("untrusted selectors and changed packages never create a window", async () => {
  const f = fixture();
  await expect(f.manager.open({} as any, target)).rejects.toThrow("untrusted source");
  await expect(f.manager.open(f.sender as any, { ...target, tabId: "other-tab" })).rejects.toThrow(
    "untrusted source",
  );
  f.prepare(async () => ({ revision: "version-two", src: "cspanel://editor-host/app/index.html" }));
  await expect(f.manager.open(f.sender as any, target)).rejects.toThrow("Panel App changed");
  expect(f.windows).toHaveLength(0);
  expect(f.unsubscribed()).toBe(1);
  expect(f.owner.listenerCount("closed")).toBe(0);
});

test("load failures and source close during preparation leave no orphan window", async () => {
  const f = fixture();
  f.load(async () => {
    throw new Error("fixture load failure");
  });
  await expect(f.manager.open(f.sender as any, target)).rejects.toThrow("fixture load failure");
  expect(f.windows[0]!.destroyed).toBe(true);
  expect(f.views[0].webContents.closeCalls).toBe(1);
  const preparation = deferred<any>();
  f.prepare(() => preparation.promise);
  const opening = f.manager.open(f.sender as any, target);
  f.revokeSource();
  preparation.resolve({ revision: "version-one" });
  await expect(opening).rejects.toThrow("Panel source closed");
  expect(f.windows).toHaveLength(1);
  expect(f.owner.listenerCount("closed")).toBe(0);
});
