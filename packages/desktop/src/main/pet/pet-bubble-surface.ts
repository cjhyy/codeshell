import type { MimiCompanionRect } from "../../shared/mimi-companion.js";
import type { MimiBubbleOpenRequest, MimiBubblePanel } from "../../shared/mimi-presence.js";
import {
  PET_CHAT_BOX,
  PET_WIDGET_WINDOW_MARGIN,
  petWidgetAlwaysOnTopLevel,
  type PetWidgetWorkArea,
} from "./pet-widget-geometry.js";

type Bounds = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** Same chat box as the docked widget's, plus its inset. */
export const PET_BUBBLE_SIZE = {
  width: PET_CHAT_BOX.width + 20,
  height: PET_CHAT_BOX.height + 12,
} as const;
/** Space between the character box and the bubble. */
const PET_BUBBLE_GAP = 4;

/**
 * Beside the character: to her right when it fits, otherwise to her left, top
 * edges aligned, always inside the work area. Without a character position the
 * bubble opens in the bottom-right corner where the docked widget would be.
 */
export function petBubbleOrigin(
  near: MimiCompanionRect | undefined,
  workArea: PetWidgetWorkArea,
  size: { width: number; height: number } = PET_BUBBLE_SIZE,
): Point {
  const margin = PET_WIDGET_WINDOW_MARGIN;
  const minX = workArea.x + margin;
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width - margin);
  const minY = workArea.y + margin;
  const maxY = Math.max(minY, workArea.y + workArea.height - size.height - margin);
  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.max(min, Math.min(max, value)));
  if (!near) return { x: maxX, y: maxY };
  const right = near.x + near.width + PET_BUBBLE_GAP;
  const left = near.x - PET_BUBBLE_GAP - size.width;
  const x = right <= maxX ? right : left >= minX ? left : right;
  return { x: clamp(x, minX, maxX), y: clamp(near.y, minY, maxY) };
}

/** The subset of BrowserWindow the bubble drives. */
export interface PetBubbleWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  getBounds(): Bounds;
  setBounds(bounds: Bounds, animate?: boolean): void;
  show(): void;
  showInactive(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  setAlwaysOnTop(flag: boolean, level?: any): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  moveTop(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  webContents: {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    on(event: string, listener: (...args: any[]) => void): unknown;
  };
}

export interface PetBubbleSurfaceOptions {
  platform: NodeJS.Platform;
  screen: {
    getDisplayNearestPoint(point: Point): { workArea: PetWidgetWorkArea };
    getPrimaryDisplay(): { workArea: PetWidgetWorkArea };
  };
  /** Pet IPC handlers must exist before the bubble renderer starts. */
  ready(): Promise<void>;
  createWindow(bounds: Bounds): PetBubbleWindowLike;
  load(win: PetBubbleWindowLike): Promise<void>;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** The bubble went away (closed or torn down); its counts no longer apply. */
  onReleased?(): void;
  log?(event: string, data?: Record<string, unknown>): void;
}

/**
 * The docked widget's chat and work list, for moving Mimi. One Mimi, one chat:
 * the moving character has no chat of her own, so clicking her opens this
 * bubble beside her. The window is loaded (hidden) while the moving form is
 * shown, which also keeps the badge counts over her head current, and is
 * visible only while a panel is open.
 */
export function createPetBubbleSurface(options: PetBubbleSurfaceOptions) {
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const forwardsMouseMovement = options.platform === "darwin" || options.platform === "win32";
  let window: PetBubbleWindowLike | null = null;
  let creation: Promise<PetBubbleWindowLike> | null = null;
  let wanted = false;
  /** The panel last asked for; shown once the renderer says it expanded. */
  let requested: MimiBubblePanel | null = null;
  let mouseInteractive = false;
  let epoch = 0;
  /** Resolves when the renderer first reports its panel, i.e. it listens. */
  let mounted: Promise<void> = Promise.resolve();
  let markMounted: (() => void) | undefined;

  const live = () => (window && !window.isDestroyed() ? window : null);

  function setMouseInteractive(
    win: PetBubbleWindowLike,
    interactive: boolean,
    force = false,
  ): void {
    // Electron forwards ignored mouse movement only on macOS and Windows.
    // Without it the renderer cannot detect re-entry, so keep Linux interactive.
    if (!forwardsMouseMovement) return;
    if (!force && mouseInteractive === interactive) return;
    if (interactive) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
    mouseInteractive = interactive;
  }

  function elevate(win: PetBubbleWindowLike): void {
    // A hide can emit blur. That must not reorder the now-empty bubble above
    // the application's real windows.
    if (win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, petWidgetAlwaysOnTopLevel(options.platform, win.isFocused()));
    try {
      win.moveTop();
    } catch {
      // The always-on-top level still applies when moveTop is unavailable.
    }
  }

  function placeWindow(win: PetBubbleWindowLike, next: Bounds, changedPanel = false): void {
    const current = win.getBounds();
    const moved =
      current.x !== next.x ||
      current.y !== next.y ||
      current.width !== next.width ||
      current.height !== next.height;
    // A new location or panel invalidates the pointer hit test. Repeated drag
    // positions and a new draft in the same chat leave a valid hover intact.
    if (moved || changedPanel) setMouseInteractive(win, false, true);
    if (moved) win.setBounds(next, false);
  }

  async function createNow(started: number): Promise<PetBubbleWindowLike> {
    await options.ready();
    if (started !== epoch || !wanted) throw new Error("气泡已收起");
    const existing = live();
    if (existing) return existing;
    const origin = petBubbleOrigin(undefined, options.screen.getPrimaryDisplay().workArea);
    const win = options.createWindow({ ...origin, ...PET_BUBBLE_SIZE });
    window = win;
    // Only the renderer's actual chat/card region may capture the mouse. The
    // rest of this transparent rectangle must leave underlying apps clickable.
    setMouseInteractive(win, false, true);
    mounted = new Promise<void>((resolve) => (markMounted = resolve));
    // The bubble may be open while the agent captures the screen; it is ours,
    // not the user's, so keep it out of captures without hiding a focused input.
    win.setContentProtection(true);
    win.webContents.on("render-process-gone", (_event: unknown, details?: { reason?: string }) => {
      options.log?.("pet-bubble.render-process-gone", { reason: details?.reason });
      if (!win.isDestroyed()) win.destroy();
    });
    // Typing lowers the level so the input method's candidates stay visible.
    win.on("focus", () => elevate(win));
    win.on("blur", () => elevate(win));
    win.on("closed", () => {
      if (window !== win) return;
      window = null;
      requested = null;
      options.onReleased?.();
    });
    try {
      await options.load(win);
    } catch (error) {
      options.log?.("pet-bubble.load.failed", { error: String(error) });
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
    if (started !== epoch || !wanted || window !== win || win.isDestroyed()) {
      if (!win.isDestroyed()) win.destroy();
      throw new Error("气泡已收起");
    }
    return win;
  }

  function ensureWindow(): Promise<PetBubbleWindowLike> {
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

  function besideBounds(near: MimiCompanionRect | undefined): Bounds {
    const center = near
      ? { x: Math.round(near.x + near.width / 2), y: Math.round(near.y + near.height / 2) }
      : undefined;
    const display = center
      ? options.screen.getDisplayNearestPoint(center)
      : options.screen.getPrimaryDisplay();
    return { ...petBubbleOrigin(near, display.workArea), ...PET_BUBBLE_SIZE };
  }

  function hide(): void {
    const win = live();
    if (!win) return;
    setMouseInteractive(win, false, true);
    if (win.isVisible()) win.hide();
  }

  /** A request sent before the renderer listens would be lost; wait (bounded). */
  function whenMounted(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimer(resolve, 3000);
      void mounted.then(() => {
        clearTimer(timer);
        resolve();
      });
    });
  }

  function release(): void {
    if (!wanted && !live()) return;
    wanted = false;
    requested = null;
    epoch++;
    creation = null;
    markMounted?.();
    const win = live();
    window = null;
    if (win) {
      setMouseInteractive(win, false, true);
      if (win.isVisible()) win.hide();
      win.destroy();
    }
    options.onReleased?.();
  }

  return {
    /** Whether the bubble stands in for the chat (the moving form is shown). */
    active: () => wanted,
    /** The moving form is shown: load the bubble hidden so its counts flow. */
    async prepare(): Promise<void> {
      wanted = true;
      await ensureWindow();
    },
    /** The moving form is gone: the docked widget has its own chat again. */
    release,
    /** Open (or, asked again for the open panel, close) the bubble beside `near`. */
    async open(
      panel: MimiBubblePanel,
      near?: MimiCompanionRect,
      prompt?: string,
      send?: boolean,
    ): Promise<void> {
      wanted = true;
      const win = await ensureWindow();
      await whenMounted();
      if (win.isDestroyed() || live() !== win) throw new Error("气泡已收起");
      if (requested === panel && win.isVisible() && !prompt) {
        requested = null;
        hide();
        win.webContents.send("pet:bubble-open", { panel: null } satisfies MimiBubbleOpenRequest);
        return;
      }
      placeWindow(win, besideBounds(near), requested !== panel);
      requested = panel;
      win.webContents.send("pet:bubble-open", {
        panel,
        ...(prompt ? { prompt, ...(send ? { send } : {}) } : {}),
      } satisfies MimiBubbleOpenRequest);
    },
    /** The character was dragged: an open bubble stays beside her. */
    follow(near: MimiCompanionRect): void {
      const win = live();
      if (win?.isVisible()) {
        placeWindow(win, besideBounds(near));
      }
    },
    /** The renderer opened or closed its panel. Only a requested panel shows. */
    setExpanded(expanded: boolean): void {
      const win = live();
      if (!win) return;
      markMounted?.();
      if (!expanded || !requested) {
        hide();
        return;
      }
      // Typing needs key focus; the work list is only looked at.
      if (requested === "chat") {
        win.show();
        win.focus();
      } else if (!win.isVisible()) win.showInactive();
      elevate(win);
    },
    /** Renderer hit testing covers the content, never the transparent window. */
    setInteractive(interactive: boolean): void {
      const win = live();
      if (!win) return;
      setMouseInteractive(win, interactive && wanted && requested !== null && win.isVisible());
    },
    window: live,
    owns(contentsId: number): boolean {
      const win = live();
      return !!win && win.webContents.id === contentsId;
    },
    dispose: release,
  };
}

export type PetBubbleSurface = ReturnType<typeof createPetBubbleSurface>;
