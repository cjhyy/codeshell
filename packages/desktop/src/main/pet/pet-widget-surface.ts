import type { MimiDockedSurface } from "./mimi-presence-controller.js";
import { dockedAnchorForFeet, dockedFeet, type Point } from "./mimi-presence-state.js";
import {
  clampPetWidgetWindowPosition,
  defaultPetWidgetWindowPosition,
  PET_WIDGET_WINDOW_SIZE,
  petWidgetAlwaysOnTopLevel,
  petWidgetSurface,
  sanitizePetWidgetWindowPosition,
  type PetWidgetSurfaceMode,
  type PetWidgetWorkArea,
} from "./pet-widget-geometry.js";

type Bounds = { x: number; y: number; width: number; height: number };

/** The subset of BrowserWindow the docked surface drives. */
export interface PetWidgetWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  getBounds(): Bounds;
  setBounds(bounds: Bounds, animate?: boolean): void;
  setPosition(x: number, y: number, animate?: boolean): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  setAlwaysOnTop(flag: boolean, level?: any): void;
  moveTop(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  webContents: {
    id: number;
    on(event: string, listener: (...args: any[]) => void): unknown;
  };
}

export interface PetWidgetScreenLike {
  getDisplayNearestPoint(point: Point): { workArea: PetWidgetWorkArea };
  getPrimaryDisplay(): { workArea: PetWidgetWorkArea };
  on(event: "display-metrics-changed" | "display-removed", listener: () => void): unknown;
  removeListener(
    event: "display-metrics-changed" | "display-removed",
    listener: () => void,
  ): unknown;
}

export interface PetWidgetSurfaceOptions {
  platform: NodeJS.Platform;
  screen: PetWidgetScreenLike;
  /** Pet IPC handlers must exist before the widget renderer starts. */
  ready(): Promise<void>;
  /** Build the hidden window at `bounds` (host-specific options live in index.ts). */
  createWindow(bounds: Bounds): PetWidgetWindowLike;
  load(win: PetWidgetWindowLike): Promise<void>;
  loadAnchor(): Point | undefined;
  saveAnchor(anchor: Point): void;
  /** The renderer crashed after it was shown. */
  onFailure(error: string): void;
  log?(event: string, data?: Record<string, unknown>): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Docked Mimi: the compact pet widget. Its window is shown only while the
 * presence owner wants it (`presenting`) and no capture is hiding it.
 */
export function createPetWidgetSurface(options: PetWidgetSurfaceOptions) {
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let window: PetWidgetWindowLike | null = null;
  let creation: Promise<PetWidgetWindowLike> | null = null;
  let loaded = false;
  let presenting = false;
  let captureHidden = false;
  let surfaceMode: PetWidgetSurfaceMode = "collapsed";
  let saveTimer: unknown = null;

  const live = () => (window && !window.isDestroyed() ? window : null);

  function originForAnchor(anchor: Point, mode: PetWidgetSurfaceMode): Point {
    const surface = petWidgetSurface(mode);
    return {
      x: anchor.x - (surface.width - PET_WIDGET_WINDOW_SIZE),
      y: anchor.y - (surface.height - PET_WIDGET_WINDOW_SIZE),
    };
  }

  function anchorForOrigin(origin: Point, mode: PetWidgetSurfaceMode): Point {
    const surface = petWidgetSurface(mode);
    return {
      x: origin.x + (surface.width - PET_WIDGET_WINDOW_SIZE),
      y: origin.y + (surface.height - PET_WIDGET_WINDOW_SIZE),
    };
  }

  function currentAnchor(win: PetWidgetWindowLike): Point {
    const { x, y } = win.getBounds();
    return anchorForOrigin({ x, y }, surfaceMode);
  }

  function clampToDisplay(position: Point, mode = surfaceMode): Point {
    const display = options.screen.getDisplayNearestPoint({
      x: position.x + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
      y: position.y + Math.round(PET_WIDGET_WINDOW_SIZE / 2),
    });
    return clampPetWidgetWindowPosition(position, display.workArea, petWidgetSurface(mode));
  }

  function persist(win: PetWidgetWindowLike): void {
    if (win.isDestroyed()) return;
    options.saveAnchor(currentAnchor(win));
  }

  function schedulePersist(win: PetWidgetWindowLike): void {
    if (saveTimer) clearTimer(saveTimer);
    saveTimer = setTimer(() => {
      saveTimer = null;
      persist(win);
    }, 250);
  }

  let raising = false;
  function elevate(win: PetWidgetWindowLike, reorder = true): void {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(true, petWidgetAlwaysOnTopLevel(options.platform, win.isFocused()));
    if (!reorder || raising) return;
    raising = true;
    try {
      // Refresh the z-order without stealing focus when the active application
      // or Space changes. On macOS, moveTop() leaves this small transparent
      // window with an opaque white backing on a 1× display (2026-11-02 mixed-DPI
      // acceptance); ordering an already visible window front again refreshes the
      // same z-order. A hidden window is never shown from here. Wayland may not
      // implement moveTop.
      if (options.platform !== "darwin") win.moveTop();
      else if (win.isVisible()) win.showInactive();
    } catch {
      // The always-on-top level still applies when reordering is unavailable.
    } finally {
      raising = false;
    }
  }

  /** The only place the window becomes visible. */
  function sync(): void {
    const win = live();
    if (!win) return;
    if (presenting && loaded && !captureHidden) {
      // Showing already orders the window front; only refresh a visible one.
      const wasVisible = win.isVisible();
      if (!wasVisible) win.showInactive();
      elevate(win, wasVisible);
    } else if (win.isVisible()) win.hide();
  }

  /** Bumped by every withdraw: a creation started before it must not finish. */
  let epoch = 0;
  const withdrawnError = () => new Error("桌宠已收起");

  async function createNow(started: number): Promise<PetWidgetWindowLike> {
    await options.ready();
    if (started !== epoch) throw withdrawnError();
    const existing = live();
    if (existing) return existing;
    const saved = options.loadAnchor();
    const anchor = saved
      ? clampToDisplay(saved, "collapsed")
      : defaultPetWidgetWindowPosition(options.screen.getPrimaryDisplay().workArea);
    const origin = originForAnchor(anchor, "collapsed");
    const win = options.createWindow({
      ...origin,
      width: PET_WIDGET_WINDOW_SIZE,
      height: PET_WIDGET_WINDOW_SIZE,
    });
    surfaceMode = "collapsed";
    loaded = false;
    window = win;
    elevate(win);
    win.webContents.on("did-finish-load", () => {
      if (window !== win || win.isDestroyed()) return;
      loaded = true;
      sync();
    });
    // A crashed renderer leaves a blank widget the visibility checks still treat
    // as open. Tear it down so the next request creates a fresh one.
    win.webContents.on("render-process-gone", (_event: unknown, details?: { reason?: string }) => {
      options.log?.("pet-widget.render-process-gone", { reason: details?.reason });
      const wasCurrent = window === win;
      if (!win.isDestroyed()) win.destroy();
      if (wasCurrent && presenting) options.onFailure("桌宠显示进程已退出，可重新打开 Mimi。");
    });
    win.on("move", () => schedulePersist(win));
    win.on("show", () => elevate(win));
    win.on("focus", () => elevate(win, false));
    win.on("blur", () => elevate(win));
    win.on("always-on-top-changed", (_event: unknown, isAlwaysOnTop: boolean) => {
      if (isAlwaysOnTop || !presenting) return;
      setImmediate(() => elevate(win));
    });
    win.on("close", () => persist(win));
    win.on("closed", () => {
      if (saveTimer) {
        clearTimer(saveTimer);
        saveTimer = null;
      }
      if (window === win) {
        window = null;
        loaded = false;
        surfaceMode = "collapsed";
      }
    });
    try {
      await options.load(win);
    } catch (error) {
      // A failed load must not leave a blank window cached; the caller retries.
      options.log?.("pet-widget.load.failed", { error: String(error) });
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
    if (started !== epoch || window !== win || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy();
      throw withdrawnError();
    }
    loaded = true;
    return win;
  }

  function ensureWindow(): Promise<PetWidgetWindowLike> {
    // A BrowserWindow exists before its renderer has loaded. All concurrent
    // presentations must await that load, including its failure.
    if (creation) return creation;
    const existing = live();
    if (existing) return Promise.resolve(existing);
    const current = createNow(epoch);
    creation = current;
    const clear = () => {
      if (creation === current) creation = null;
    };
    current.then(clear, clear);
    return current;
  }

  function destroy(): void {
    const win = live();
    if (!win) return;
    persist(win);
    if (win.isVisible()) win.hide();
    win.destroy();
  }

  const onDisplaysChanged = () => {
    const win = live();
    if (!win) return;
    const anchor = clampToDisplay(currentAnchor(win));
    const origin = originForAnchor(anchor, surfaceMode);
    const bounds = win.getBounds();
    if (bounds.x !== origin.x || bounds.y !== origin.y) win.setPosition(origin.x, origin.y, false);
  };
  options.screen.on("display-metrics-changed", onDisplaysChanged);
  options.screen.on("display-removed", onDisplaysChanged);

  const surface: MimiDockedSurface & {
    window(): PetWidgetWindowLike | null;
    owns(contentsId: number): boolean;
    setSurfaceMode(mode: PetWidgetSurfaceMode): void;
    moveTo(rawOrigin: unknown): void;
    dispose(): void;
  } = {
    async present(isCurrent) {
      presenting = true;
      const win = await ensureWindow();
      // A newer request may have withdrawn this form while it was loading.
      if (!presenting || !isCurrent() || win.isDestroyed()) return;
      sync();
    },
    withdraw() {
      presenting = false;
      epoch++;
      creation = null;
      destroy();
    },
    isVisible() {
      return Boolean(live()?.isVisible());
    },
    feet() {
      const win = live();
      const anchor = win ? currentAnchor(win) : options.loadAnchor();
      return anchor ? dockedFeet(anchor) : undefined;
    },
    placeFeet(feet) {
      const anchor = clampToDisplay(dockedAnchorForFeet(feet), "collapsed");
      options.saveAnchor(anchor);
      const win = live();
      if (!win) return;
      const origin = originForAnchor(clampToDisplay(anchor), surfaceMode);
      win.setPosition(origin.x, origin.y, false);
    },
    setCaptureHidden(hidden) {
      const wasVisible = Boolean(live()?.isVisible());
      captureHidden = hidden;
      sync();
      return hidden && wasVisible;
    },
    window: live,
    owns(contentsId) {
      const win = live();
      return !!win && win.webContents.id === contentsId;
    },
    setSurfaceMode(mode) {
      const win = live();
      if (!win || surfaceMode === mode) return;
      const anchor = currentAnchor(win);
      const nextAnchor = clampToDisplay(anchor, mode);
      const origin = originForAnchor(nextAnchor, mode);
      surfaceMode = mode;
      win.setBounds({ ...origin, ...petWidgetSurface(mode) }, true);
      elevate(win);
    },
    moveTo(rawOrigin) {
      const win = live();
      const position = sanitizePetWidgetWindowPosition(rawOrigin);
      if (!win || !position) return;
      const nextAnchor = clampToDisplay(anchorForOrigin(position, surfaceMode));
      const origin = originForAnchor(nextAnchor, surfaceMode);
      win.setPosition(origin.x, origin.y, false);
    },
    dispose() {
      options.screen.removeListener("display-metrics-changed", onDisplaysChanged);
      options.screen.removeListener("display-removed", onDisplaysChanged);
      presenting = false;
      epoch++;
      creation = null;
      destroy();
    },
  };
  return surface;
}

export type PetWidgetSurface = ReturnType<typeof createPetWidgetSurface>;
