import { describe, expect, test } from "bun:test";
import { createPetWidgetSurface, type PetWidgetWindowLike } from "./pet-widget-surface";
import type { Point } from "./mimi-presence-state";

type Bounds = { x: number; y: number; width: number; height: number };
type Listener = (...args: any[]) => void;

class FakeWindow implements PetWidgetWindowLike {
  destroyed = false;
  visible = false;
  shows = 0;
  listeners = new Map<string, Listener[]>();
  contentListeners = new Map<string, Listener[]>();
  constructor(
    public bounds: Bounds,
    readonly id: number,
  ) {}
  webContents = {
    id: 0,
    on: (event: string, listener: Listener) => {
      this.contentListeners.set(event, [...(this.contentListeners.get(event) ?? []), listener]);
    },
  };
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible && !this.destroyed;
  }
  focused = false;
  isFocused() {
    return this.focused;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: Bounds) {
    this.bounds = { ...bounds };
  }
  setPosition(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y };
    this.emit("move");
  }
  showInactive() {
    if (this.destroyed) throw new Error("destroyed window shown");
    this.visible = true;
    this.shows++;
  }
  hide() {
    this.visible = false;
  }
  destroy() {
    if (this.destroyed) return;
    this.emit("close");
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
  levels: unknown[] = [];
  setAlwaysOnTop(_flag: boolean, level?: unknown) {
    this.levels.push(level);
  }
  moveTops = 0;
  moveTop() {
    this.moveTops++;
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  emitContents(event: string, ...args: unknown[]) {
    for (const listener of this.contentListeners.get(event) ?? []) listener(...args);
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(platform: NodeJS.Platform = "darwin") {
  const windows: FakeWindow[] = [];
  const loads: Array<{ win: FakeWindow; resolve(): void; reject(error: Error): void }> = [];
  const saved: Point[] = [];
  const failures: string[] = [];
  const screenListeners = new Map<string, Array<() => void>>();
  let anchor: Point | undefined;
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const surface = createPetWidgetSurface({
    platform,
    screen: {
      getDisplayNearestPoint: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
      on: (event, listener) => {
        screenListeners.set(event, [...(screenListeners.get(event) ?? []), listener]);
      },
      removeListener: (event, listener) => {
        screenListeners.set(
          event,
          (screenListeners.get(event) ?? []).filter((item) => item !== listener),
        );
      },
    },
    ready: async () => {},
    createWindow: (bounds) => {
      const win = new FakeWindow(bounds, windows.length + 1);
      win.webContents.id = 100 + windows.length;
      windows.push(win);
      return win;
    },
    load: (win) =>
      new Promise<void>((resolve, reject) => {
        loads.push({ win: win as FakeWindow, resolve, reject });
      }),
    loadAnchor: () => anchor,
    saveAnchor: (next) => {
      anchor = next;
      saved.push(next);
    },
    onFailure: (error) => failures.push(error),
    setTimer: (run) => {
      run();
      return 1;
    },
    clearTimer: () => {},
  });
  /** Finish a load the way Electron does: did-finish-load, then the promise. */
  const finish = (index = 0) => {
    const load = loads.splice(index, 1)[0]!;
    if (!load.win.destroyed) load.win.emitContents("did-finish-load");
    load.resolve();
  };
  return {
    surface,
    windows,
    loads,
    saved,
    failures,
    finish,
    setWorkArea: (next: typeof workArea) => {
      workArea = next;
    },
    displaysChanged: () => screenListeners.get("display-metrics-changed")?.forEach((run) => run()),
    displayRemoved: () => screenListeners.get("display-removed")?.forEach((run) => run()),
    screenListeners,
  };
}

describe("docked pet widget surface", () => {
  test("is shown only after load and only while presented", async () => {
    const h = setup();
    const presented = h.surface.present(() => true);
    await flush();
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]!.visible).toBe(false);
    h.finish();
    await presented;
    expect(h.windows[0]!.visible).toBe(true);
    expect(h.surface.isVisible()).toBe(true);
  });

  test("concurrent presentations share one window", async () => {
    const h = setup();
    const first = h.surface.present(() => true);
    const second = h.surface.present(() => true);
    await flush();
    expect(h.windows).toHaveLength(1);
    h.finish();
    await Promise.all([first, second]);
    expect(h.windows[0]!.visible).toBe(true);
  });

  test("a repeated presentation waits for the renderer load and sees its failure", async () => {
    const h = setup();
    const first = h.surface.present(() => false).catch((error) => error);
    await flush();
    let settled = false;
    const second = h.surface
      .present(() => true)
      .then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
    await flush();
    expect(settled).toBe(false);
    h.loads.splice(0, 1)[0]!.reject(new Error("renderer load failed"));
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(h.surface.isVisible()).toBe(false);
    expect(h.windows[0]!.destroyed).toBe(true);
  });

  test("withdraw during load destroys the window; the late load and did-finish-load never show it", async () => {
    const h = setup();
    const presented = h.surface.present(() => true);
    await flush();
    const first = h.windows[0]!;
    h.surface.withdraw();
    expect(first.destroyed).toBe(true);
    first.emitContents("did-finish-load");
    h.loads.splice(0, 1)[0]!.resolve();
    await expect(presented).rejects.toThrow();
    expect(first.shows).toBe(0);
    expect(h.surface.isVisible()).toBe(false);
  });

  test("withdraw then present again starts a fresh window instead of reusing the dying one", async () => {
    const h = setup();
    const stale = h.surface.present(() => true);
    await flush();
    h.surface.withdraw();
    const fresh = h.surface.present(() => true);
    await flush();
    expect(h.windows).toHaveLength(2);
    h.loads.splice(0, 1)[0]!.reject(new Error("ERR_ABORTED"));
    await expect(stale).rejects.toThrow();
    h.finish();
    await fresh;
    expect(h.windows[1]!.visible).toBe(true);
    expect(h.windows[0]!.shows).toBe(0);
  });

  test("a renderer crash while presented reports a failure; a crash after withdraw does not", async () => {
    const h = setup();
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    h.windows[0]!.emitContents("render-process-gone", {}, { reason: "crashed" });
    expect(h.windows[0]!.destroyed).toBe(true);
    expect(h.failures).toHaveLength(1);
    const again = h.surface.present(() => true);
    await flush();
    h.finish();
    await again;
    h.surface.withdraw();
    h.windows[1]!.emitContents("render-process-gone", {}, { reason: "killed" });
    expect(h.failures).toHaveLength(1);
  });

  test("capture hides the docked window and restores it only while still presented", async () => {
    const h = setup();
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    expect(h.surface.setCaptureHidden(true)).toBe(true);
    expect(h.windows[0]!.visible).toBe(false);
    h.surface.setCaptureHidden(false);
    expect(h.windows[0]!.visible).toBe(true);
    h.surface.setCaptureHidden(true);
    h.surface.withdraw();
    h.surface.setCaptureHidden(false);
    expect(h.windows.some((win) => win.visible)).toBe(false);
  });

  test("a stale presentation (no longer current) does not show the window", async () => {
    const h = setup();
    let current = true;
    const presented = h.surface.present(() => current);
    await flush();
    current = false;
    // did-finish-load still shows while marked; the owner withdraws stale forms.
    h.surface.withdraw();
    h.finish();
    await expect(presented).rejects.toThrow();
    expect(h.windows[0]!.shows).toBe(0);
  });

  test("macOS refreshes z-order without moveTop and never shows a hidden widget from it", async () => {
    // moveTop() left the 112 DIP transparent widget on an opaque white backing on
    // a 1× display (2026-11-02 mixed-DPI acceptance). Ordering a visible window
    // front again is the same refresh; it must not reveal a withdrawn/hidden one.
    const h = setup("darwin");
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    const win = h.windows[0]!;
    expect(win.isVisible()).toBe(true);
    const shown = win.shows;
    win.emit("blur");
    win.emit("show");
    expect(win.shows).toBe(shown + 2);
    expect(win.moveTops).toBe(0);
    expect(h.surface.setCaptureHidden(true)).toBe(true);
    win.emit("blur");
    win.emit("always-on-top-changed", {}, true);
    expect(win.isVisible()).toBe(false);
    expect(win.shows).toBe(shown + 2);
    h.surface.setCaptureHidden(false);
    expect(win.isVisible()).toBe(true);
    expect(win.moveTops).toBe(0);
    h.surface.dispose();
  });

  test("typing into the docked chat drops below the input method's candidate window", async () => {
    const h = setup("darwin");
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    const win = h.windows[0]!;
    const shown = win.shows;
    win.focused = true;
    win.emit("focus");
    expect(win.levels.at(-1)).toBe("floating");
    expect(win.shows).toBe(shown);
    win.focused = false;
    win.emit("blur");
    expect(win.levels.at(-1)).toBe("screen-saver");
    h.surface.dispose();
  });

  test("other platforms keep moveTop for the z-order refresh", async () => {
    const h = setup("linux");
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    const win = h.windows[0]!;
    const before = win.moveTops;
    const shown = win.shows;
    win.emit("blur");
    expect(win.moveTops).toBe(before + 1);
    expect(win.shows).toBe(shown);
    h.surface.dispose();
  });

  test("display removal/metrics change clamps the docked window back into the work area", async () => {
    const h = setup();
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    const win = h.windows[0]!;
    win.bounds = { ...win.bounds, x: 3000, y: 1500 };
    h.setWorkArea({ x: 0, y: 0, width: 1440, height: 900 });
    h.displayRemoved();
    expect(win.bounds.x).toBe(1440 - 112 - 12);
    expect(win.bounds.y).toBe(900 - 112 - 12);
    win.bounds = { ...win.bounds, x: -500 };
    h.displaysChanged();
    expect(win.bounds.x).toBe(12);
    h.surface.dispose();
    expect(h.screenListeners.get("display-removed")).toEqual([]);
    expect(h.screenListeners.get("display-metrics-changed")).toEqual([]);
  });

  test("feet/placeFeet round-trip and persist the clamped docked anchor", async () => {
    const h = setup();
    h.surface.placeFeet({ x: 456, y: 404 });
    expect(h.saved.at(-1)).toEqual({ x: 400, y: 300 });
    expect(h.surface.feet()).toEqual({ x: 456, y: 404 });
    // Off-screen feet clamp into the work area.
    h.surface.placeFeet({ x: 99999, y: 99999 });
    expect(h.saved.at(-1)).toEqual({ x: 1920 - 112 - 12, y: 1080 - 112 - 12 });
    const presented = h.surface.present(() => true);
    await flush();
    expect(h.windows[0]!.bounds).toMatchObject({ x: 1920 - 112 - 12, y: 1080 - 112 - 12 });
    h.finish();
    await presented;
  });

  test("only the live widget owns IPC; expanded surface keeps the anchor fixed", async () => {
    const h = setup();
    expect(h.surface.owns(100)).toBe(false);
    const presented = h.surface.present(() => true);
    await flush();
    h.finish();
    await presented;
    expect(h.surface.owns(100)).toBe(true);
    const before = h.surface.feet();
    h.surface.setSurfaceMode("expanded");
    expect(h.windows[0]!.bounds).toMatchObject({ width: 440, height: 512 });
    expect(h.surface.feet()).toEqual(before);
    h.surface.withdraw();
    expect(h.surface.owns(100)).toBe(false);
  });
});
