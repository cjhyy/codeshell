import { app, BrowserWindow, ipcMain, screen, session, type WebContents } from "electron";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  companionSize,
  MIMI_COMPANION_DEFAULT_SIZE,
  MIMI_COMPANION_SCHEME,
  type MimiCompanionAttention,
  type MimiCompanionRect,
  type MimiCompanionSettings,
  type MimiCompanionState,
} from "../../shared/mimi-companion.js";
import { CompanionChoreographer, type CompanionPlacementScene } from "./companion-choreographer.js";
import type { AppProfileIndex } from "./app-profiles.js";
import { clearsFieldAtOnce, stagePlacement } from "./stage-model.js";
import { windowAtPoint } from "./window-at-point.js";
import { petWidgetAlwaysOnTopLevel } from "../pet/pet-widget-geometry.js";
import { movingAnchorForFeet, movingFeet } from "../pet/mimi-presence-state.js";
import type { ComputerActivityBus } from "./computer-activity-bus.js";
import type { InputGate } from "./input-gate.js";

/** A closed chat keeps foreground input held this long, in case it reopens. */
const CHAT_RELEASE_MS = 10_000;
/** An unanswered "look at this window?" offer withdraws itself. */
const HANDOFF_OFFER_MS = 8_000;

/**
 * How the single Mimi presence owner hears from the moving surface. Without it
 * (the standalone effect lab) the host keeps its own enabled switch.
 */
export interface MimiCompanionPresenceHooks {
  /** Initial size and user-pinned position from the unified presence file. */
  initial?: { size?: number; anchor?: { x: number; y: number } };
  /** The user pinned (or released) the character; persist with the presence. */
  onAnchorChange?(anchor: { x: number; y: number } | undefined): void;
  /** The renderer crashed or the window was lost while presented. */
  onFailure?(error: string): void;
  /** The settings preview finished on its own. */
  onPreviewEnd?(): void;
  /** A capture started/ended; returns whether another Mimi form was hidden. */
  onCaptureChange?(capturing: boolean): boolean;
  /** The character's own menu asked to dock or close Mimi. */
  request?(action: "dock" | "close"): void;
}

export interface MimiCompanionHostOptions {
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  devUrl?: string;
  isMainWindow(sender: WebContents): boolean;
  /** Mimi chat surfaces allowed to hold foreground input (defaults to main windows). */
  isChatSurface?(sender: WebContents): boolean;
  presence?: MimiCompanionPresenceHooks;
  /**
   * Open the Mimi chat; `prompt` is placed in the composer, never sent. `near`
   * is where the character stands, so the chat can open beside her.
   */
  openChat(request?: { prompt: string }, near?: MimiCompanionRect): Promise<void>;
  /** Open the work list from the character's badge. */
  openActivity?(near?: MimiCompanionRect): Promise<void>;
  holdForChat?: boolean;
  /** Execution-side activity, published by the CUA proxy channel. */
  bus: ComputerActivityBus;
  /** Execution gate. The character only requests holds; it never enforces them. */
  gate: InputGate;
  /** Per-app stage hints (where to stand, what never to cover, when to stay quiet). */
  appProfiles?: AppProfileIndex;
  log(event: string, data?: Record<string, unknown>): void;
}

/** A full character surface, independent of both the pointer and the chat widget. */
export async function createMimiCompanionHost(options: MimiCompanionHostOptions) {
  const hooks = options.presence ?? {};
  /** Whether the presence owner wants this form shown. Never true together with docked. */
  let presenting = false;
  /** Effect-lab switch, used only when no presence owner drives this host. */
  let standaloneEnabled = false;
  let size = companionSize(hooks.initial?.size ?? MIMI_COMPANION_DEFAULT_SIZE);
  let anchor: { x: number; y: number } | undefined;
  let pinned = false;
  let humanActive = false;
  let chatting = false;
  const chatSurfaces = new Set<WebContents>();
  let dragging = false;
  let dragged = false;
  let handoff: { app: string } | undefined;
  let attention: MimiCompanionAttention | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const initialAnchor = hooks.initial?.anchor;
  if (validPoint(initialAnchor)) {
    anchor = { x: initialAnchor.x, y: initialAnchor.y };
    pinned = true;
  }
  let captureNotified = false;
  /** Tell the owner when captures start/end so the docked form hides too. */
  const syncCapture = (): boolean => {
    const capturing = choreographer.capturing && !disposed;
    if (capturing === captureNotified) return false;
    captureNotified = capturing;
    return hooks.onCaptureChange?.(capturing) ?? false;
  };

  let window: BrowserWindow | undefined;
  let creating: Promise<void> | undefined;
  let creationEpoch = 0;
  let disposed = false;
  let ready = false;
  let error: string | undefined;
  let preview = false;
  let previewSequence = 0;
  let previewTimers: Array<ReturnType<typeof setTimeout>> = [];
  let previewExpiry: ReturnType<typeof setTimeout> | undefined;
  let chatRelease: ReturnType<typeof setTimeout> | undefined;
  let captureBarrier: Promise<void> = Promise.resolve();
  let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (anchor) display = screen.getDisplayNearestPoint(anchor);
  let target: { x: number; y: number } | undefined;
  let avoidRect: { x: number; y: number; width: number; height: number } | undefined;
  let scene: CompanionPlacementScene = {};
  const choreographer = new CompanionChoreographer({
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // Chatting with Mimi holds foreground input only (input-gate); the work the
    // chat asked for is still performed. Only touching the character yields.
    suppressed: () => humanActive,
    place: placeAt,
    beginGesture: () => {
      if (preview) {
        cancelPreview();
        // Real work replaced the preview; the owner returns to the user's form.
        if (hooks.onPreviewEnd) hooks.onPreviewEnd();
        else if (!standaloneEnabled) withdraw();
      }
      if (presenting)
        void ensureWindow().catch((failure) => {
          options.log("mimi_companion_load_failed", { error: String(failure) });
        });
    },
    hideForCapture: async () => {
      const wasVisible = window?.isVisible() ?? false;
      // Hides whichever Mimi form is on screen, docked included.
      const otherHidden = syncCapture();
      publish();
      // Acknowledge only after the hidden window has had time to leave the
      // compositor. The proxy bounds this wait and never retries input.
      if (wasVisible || otherHidden)
        captureBarrier = new Promise((resolve) => setTimeout(resolve, 50));
      await captureBarrier;
    },
    publish,
  });
  const assetRoot = options.packaged
    ? join(options.resourcesPath, "mimi-live2d")
    : join(options.appPath, "out", "mimi-live2d");

  function normalizeAnchor() {
    if (!anchor) return;
    display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + size * 0.35),
      y: Math.round(anchor.y + size / 2),
    });
    const area = display.workArea;
    anchor = {
      x: Math.round(Math.max(area.x, Math.min(area.x + area.width - size * 0.7, anchor.x))),
      y: Math.round(Math.max(area.y, Math.min(area.y + area.height - size, anchor.y))),
    };
  }
  normalizeAnchor();

  const state = (): MimiCompanionState => {
    const bounds = window && !window.isDestroyed() ? window.getContentBounds() : display.bounds;
    const placement = stagePlacement(bounds, size, {
      target,
      avoidRect: humanActive || pinned ? undefined : avoidRect,
      window: scene.window,
      prefer: options.appProfiles?.byId(scene.appId)?.stage.perch,
      ...(target && scene.element && scene.elementFrame
        ? { surface: { kind: scene.element, frame: scene.elementFrame } }
        : {}),
    });
    if (anchor) placement.position = { x: anchor.x - bounds.x, y: anchor.y - bounds.y };
    return {
      enabled: presenting,
      visible: presenting && !choreographer.capturing && !placement.obstructed && !disposed,
      appearance: "mimi-sprite",
      modelUrl: `${MIMI_COMPANION_SCHEME}://assets/Hiyori/Hiyori.model3.json`,
      coreUrl: `${MIMI_COMPANION_SCHEME}://assets/Core/live2dcubismcore.min.js`,
      ...placement,
      // Working on a control draws the character smaller; where the human put
      // it, it keeps the size they chose.
      size: (!anchor && placement.size) || size,
      windowOrigin: { x: bounds.x, y: bounds.y },
      humanActive,
      avoidInput: clearsFieldAtOnce(avoidRect, scene.element) && !humanActive && !pinned,
      pinned,
      ...(handoff ? { handoff: { app: handoff.app } } : {}),
      ...(target && scene.element ? { element: scene.element } : {}),
      activity: choreographer.activity,
      preview,
      ...(attention ? { attention: { ...attention } } : {}),
      control: options.gate.status(),
    };
  };

  /** The character box as drawn right now, in global DIP. */
  function characterRect(): MimiCompanionRect | undefined {
    if (!presenting || !window || window.isDestroyed()) return undefined;
    const current = state();
    const origin = current.windowOrigin ?? { x: 0, y: 0 };
    return {
      x: Math.round(origin.x + current.position.x),
      y: Math.round(origin.y + current.position.y),
      width: Math.round(current.size * 0.7),
      height: Math.round(current.size),
    };
  }

  function validPoint(value: unknown): value is { x: number; y: number } {
    if (!value || typeof value !== "object") return false;
    const point = value as { x?: unknown; y?: unknown };
    return (
      typeof point.x === "number" &&
      typeof point.y === "number" &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Math.abs(point.x) < 100_000 &&
      Math.abs(point.y) < 100_000
    );
  }

  /** Position belongs to the unified presence file, written by its owner. */
  const persist = async () => {
    hooks.onAnchorChange?.(pinned && anchor ? { ...anchor } : undefined);
  };

  function publish() {
    syncCapture();
    if (!window || window.isDestroyed() || disposed) return;
    const next = state();
    window.webContents.send("mimiCompanion:state", next);
    // The only place this window becomes visible: only while presented.
    if (presenting && next.visible && ready && !error) {
      window.showInactive();
      elevate(window);
    } else window.hide();
  }

  function elevate(win: BrowserWindow) {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(true, petWidgetAlwaysOnTopLevel(process.platform));
    try {
      win.moveTop();
    } catch {
      /* Some window managers do not support moveTop. */
    }
  }

  async function ensureWindow() {
    if (disposed || (window && !window.isDestroyed())) return;
    if (creating) return creating;
    // A withdraw bumps the epoch: a creation started before it must not build
    // a window, and a new presentation must not wait on that stale creation.
    const epoch = creationEpoch;
    const current = (async () => {
      ready = false;
      error = undefined;
      const isolated = session.fromPartition("mimi-companion");
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.webRequest.onHeadersReceived((details, callback) => {
        const script = options.devUrl ? "'self' 'unsafe-inline'" : "'self'";
        const connect = options.devUrl ? "'self' ws: csmimi:" : "'self' csmimi:";
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [
              `default-src 'none'; script-src ${script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: csmimi:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
            ],
          },
        });
      });
      if (!(await isolated.protocol.isProtocolHandled(MIMI_COMPANION_SCHEME))) {
        isolated.protocol.handle(MIMI_COMPANION_SCHEME, async (request) => {
          try {
            const url = new URL(request.url);
            if (url.hostname !== "assets" || request.method !== "GET")
              return new Response(null, { status: 403 });
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
            const root = await realpath(assetRoot);
            const file = await realpath(resolve(root, relative));
            if (!file.startsWith(root + sep)) return new Response(null, { status: 403 });
            const mime: Record<string, string> = {
              ".json": "application/json",
              ".moc3": "application/octet-stream",
              ".png": "image/png",
              ".js": "text/javascript",
            };
            if (!mime[extname(file)]) return new Response(null, { status: 403 });
            return new Response(new Uint8Array(await readFile(file)), {
              headers: { "Content-Type": mime[extname(file)]!, "Access-Control-Allow-Origin": "*" },
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        });
      }
      if (disposed || !presenting || epoch !== creationEpoch) return;
      const win = new BrowserWindow({
        ...display.bounds,
        // NSPanel participates in other apps' fullscreen Spaces without
        // activating this app or taking keyboard focus from their editors.
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        show: false,
        transparent: true,
        backgroundColor: "#00000000",
        frame: false,
        hasShadow: false,
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        acceptFirstMouse: true,
        webPreferences: {
          preload: join(options.appPath, "out", "preload", "mimi-companion.cjs"),
          partition: "mimi-companion",
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      window = win;
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
      elevate(win);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setHiddenInMissionControl(true);
      win.on("show", () => elevate(win));
      win.on("blur", () => elevate(win));
      win.on("always-on-top-changed", (_event, isAlwaysOnTop) => {
        if (!isAlwaysOnTop && !disposed) setImmediate(() => elevate(win));
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.on("render-process-gone", () => {
        const current = window === win;
        if (current) error = "角色显示进程已退出，可在 Mimi 设置里重试移动模式。";
        if (!win.isDestroyed()) win.destroy();
        // Shown and then lost: the owner hides it and falls back to docked.
        if (current && presenting && !disposed) hooks.onFailure?.(error!);
      });
      win.on("closed", () => {
        if (window === win) {
          window = undefined;
          ready = false;
        }
      });
      try {
        if (options.devUrl)
          await win.loadURL(`${options.devUrl.replace(/\/$/, "")}/mimi-companion.html`);
        else await win.loadFile(join(options.appPath, "out", "renderer", "mimi-companion.html"));
      } catch (failure) {
        // Withdrawn while loading: the abort is expected, not a failure.
        if (window !== win || !presenting) return;
        error = "角色显示未能加载，可在 Mimi 设置里重试移动模式。";
        options.log("mimi_companion_load_failed", { error: String(failure) });
        if (!win.isDestroyed()) win.destroy();
      }
    })().finally(() => {
      if (creating === current) creating = undefined;
    });
    creating = current;
    return current;
  }

  function cancelPreview() {
    previewTimers.forEach(clearTimeout);
    previewTimers = [];
    if (previewExpiry) clearTimeout(previewExpiry);
    preview = false;
  }

  function placeAt(
    point: { x: number; y: number } | undefined,
    reserved?: { x: number; y: number; width: number; height: number },
    where: CompanionPlacementScene = {},
  ) {
    const hints = options.appProfiles?.byId(where.appId)?.stage;
    // A quiet app keeps the character where it is; the action still plays.
    if (hints?.quiet) point = undefined;
    if (!reserved && where.element && hints?.keepClear.includes(where.element))
      reserved = where.elementFrame;
    // Unknown agent coordinates never mean the human's system pointer.
    if (!point && !anchor) {
      const current = state();
      anchor = {
        x: current.windowOrigin!.x + current.position.x,
        y: current.windowOrigin!.y + current.position.y,
      };
    }
    target = point;
    avoidRect = reserved;
    scene = point ? where : {};
    if (!target) return;
    // A drag holds the character only while nothing is happening; the next
    // operation takes it back to the work.
    if (pinned) {
      pinned = false;
      void persist();
    }
    anchor = undefined;
    const next = screen.getDisplayNearestPoint({
      x: Math.round(target.x),
      y: Math.round(target.y),
    });
    if (next.id !== display.id) {
      display = next;
      window?.setBounds(display.bounds);
    }
  }

  const unsubscribeBus = options.bus.subscribe({
    onOperation: (event) => (disposed ? undefined : choreographer.receive(event)),
    onRun: (run) => choreographer.run(run),
  });
  const unsubscribeGate = options.gate.subscribe(() => publish());
  const ownOverlay = (sender: WebContents, frame: unknown) =>
    !sender.isDestroyed() && window?.webContents === sender && frame === sender.mainFrame;
  ipcMain.handle("mimiCompanion:state", (event) => {
    if (!ownOverlay(event.sender, event.senderFrame)) throw new Error("Invalid companion surface");
    return state();
  });
  const onReady = (event: Electron.IpcMainEvent, result?: { error?: unknown }) => {
    if (!ownOverlay(event.sender, event.senderFrame)) return;
    error = typeof result?.error === "string" ? result.error.slice(0, 240) : undefined;
    ready = !error;
    publish();
  };
  ipcMain.on("mimiCompanion:ready", onReady);
  const stopPresentation = () => {
    previewTimers.forEach(clearTimeout);
    previewTimers = [];
    choreographer.interrupt();
    target = undefined;
    avoidRect = undefined;
    scene = {};
  };
  const syncChatFocus = () => {
    if (disposed) return;
    for (const contents of chatSurfaces) {
      if (contents.isDestroyed()) chatSurfaces.delete(contents);
    }
    const focused = BrowserWindow.getFocusedWindow();
    const next = !!focused && chatSurfaces.has(focused.webContents);
    if (chatting === next) return;
    chatting = next;
    if (chatRelease) clearTimeout(chatRelease);
    chatRelease = undefined;
    if (chatting) {
      options.gate.holdForegroundForChat();
    } else {
      // Leaving the chat releases foreground input only after it stays closed.
      chatRelease = setTimeout(() => {
        chatRelease = undefined;
        if (!chatting && !disposed) options.gate.releaseForegroundForChat();
      }, CHAT_RELEASE_MS);
    }
    publish();
  };
  // A chat hold belongs to the visible, focused chat page. Leaving the page or
  // switching back to work releases it; dragging still keeps the saved anchor.
  ipcMain.handle("mimiCompanion:chatActive", (event, value: unknown) => {
    const chatSurface = options.isChatSurface ?? options.isMainWindow;
    if (
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !chatSurface(event.sender) ||
      typeof value !== "boolean"
    ) {
      throw new Error("Invalid companion chat surface");
    }
    if (value) chatSurfaces.add(event.sender);
    else chatSurfaces.delete(event.sender);
    syncChatFocus();
  });
  const onChatWindowFocus = () => setImmediate(syncChatFocus);
  app.on("browser-window-focus", onChatWindowFocus);
  app.on("browser-window-blur", onChatWindowFocus);
  const onInteraction = (event: Electron.IpcMainEvent, phase: unknown) => {
    if (
      !ownOverlay(event.sender, event.senderFrame) ||
      !["hover", "leave", "begin", "end"].includes(String(phase))
    )
      return;
    if (phase === "hover" || phase === "begin") {
      if (!anchor) {
        const current = state();
        anchor = {
          x: current.position.x + current.windowOrigin!.x,
          y: current.position.y + current.windowOrigin!.y,
        };
      }
      humanActive = true;
      if (phase === "begin") {
        dragging = true;
        dragged = false;
      }
      stopPresentation();
      window?.setIgnoreMouseEvents(false);
    } else {
      if (phase === "leave" && dragging) return;
      if (phase === "end") {
        dragging = false;
        if (dragged) void offerHandoff();
        dragged = false;
        void persist().catch(() => {});
        // Keep the pet clickable while the pointer still rests over its body.
        publish();
        return;
      }
      humanActive = false;
      window?.setIgnoreMouseEvents(true, { forward: true });
      window?.setFocusable(false);
    }
    publish();
  };
  const onMove = (event: Electron.IpcMainEvent, point: unknown) => {
    if (!ownOverlay(event.sender, event.senderFrame) || !dragging || !validPoint(point)) return;
    const next = screen.getDisplayNearestPoint({
      x: Math.round(point.x + size * 0.35),
      y: Math.round(point.y + size / 2),
    });
    const area = next.workArea;
    anchor = {
      x: Math.round(Math.max(area.x, Math.min(area.x + area.width - size * 0.7, point.x))),
      y: Math.round(Math.max(area.y, Math.min(area.y + area.height - size, point.y))),
    };
    pinned = true;
    dragged = true;
    withdrawHandoff();
    if (display.id !== next.id) {
      display = next;
      window?.setBounds(display.bounds);
    }
    publish();
  };
  // Dropping Mimi on another app's window offers to bring that window into the
  // chat. Only the app's name travels, and only after the user confirms.
  function withdrawHandoff() {
    if (handoffTimer) clearTimeout(handoffTimer);
    handoffTimer = undefined;
    handoff = undefined;
  }
  async function offerHandoff() {
    if (!anchor || disposed) return;
    const feet = { x: anchor.x + size * 0.35, y: anchor.y + size * 0.9 };
    const ownPids = new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]);
    const found = await windowAtPoint(feet, ownPids).catch(() => undefined);
    if (!found || disposed || dragging) return;
    withdrawHandoff();
    handoff = { app: found.app };
    handoffTimer = setTimeout(() => {
      withdrawHandoff();
      publish();
    }, HANDOFF_OFFER_MS);
    publish();
  }
  const onFollow = (event: Electron.IpcMainEvent) => {
    if (!ownOverlay(event.sender, event.senderFrame)) return;
    pinned = false;
    chatting = false;
    humanActive = false;
    dragging = false;
    anchor = undefined;
    stopPresentation();
    window?.setIgnoreMouseEvents(true, { forward: true });
    window?.setFocusable(false);
    void persist().catch(() => {});
    publish();
  };
  // Stop/resume from the character are requests to the execution gate. They
  // work while the character is idle, hidden by a capture, or mid-gesture.
  const onStopComputer = (event: Electron.IpcMainEvent) => {
    if (!ownOverlay(event.sender, event.senderFrame)) return;
    options.gate.stopAll();
    options.log("computer_input_stopped", { source: "companion" });
  };
  const onResumeComputer = (event: Electron.IpcMainEvent) => {
    if (!ownOverlay(event.sender, event.senderFrame)) return;
    options.gate.resume();
    options.log("computer_input_resumed", { source: "companion" });
  };
  // Dock/close from the character's own menu go to the single presence owner,
  // which hides this surface before it shows the other one.
  const onPresence = (event: Electron.IpcMainEvent, action: unknown) => {
    if (!ownOverlay(event.sender, event.senderFrame) || !presenting) return;
    if (action !== "dock" && action !== "close") return;
    hooks.request?.(action);
  };
  ipcMain.on("mimiCompanion:presence", onPresence);
  ipcMain.on("mimiCompanion:stopComputer", onStopComputer);
  ipcMain.on("mimiCompanion:resumeComputer", onResumeComputer);
  ipcMain.on("mimiCompanion:interaction", onInteraction);
  ipcMain.on("mimiCompanion:move", onMove);
  ipcMain.on("mimiCompanion:follow", onFollow);
  async function startChat(request?: { prompt: string }) {
    // Where she stands before the chat changes anything.
    const near = characterRect();
    // Opening the chat is not a placement: only a drag pins the character.
    chatting = options.holdForChat !== false;
    if (chatting) {
      if (chatRelease) clearTimeout(chatRelease);
      chatRelease = undefined;
      options.gate.holdForegroundForChat();
    }
    stopPresentation();
    humanActive = false;
    dragging = false;
    window?.setIgnoreMouseEvents(true, { forward: true });
    window?.setFocusable(false);
    await persist();
    try {
      await options.openChat(request, near);
    } catch (failure) {
      chatting = false;
      publish();
      throw failure;
    }
    syncChatFocus();
    publish();
  }
  ipcMain.handle("mimiCompanion:chat", async (event) => {
    if (!ownOverlay(event.sender, event.senderFrame)) throw new Error("Invalid companion surface");
    await startChat();
  });
  ipcMain.handle("mimiCompanion:activity", async (event) => {
    if (!ownOverlay(event.sender, event.senderFrame)) throw new Error("Invalid companion surface");
    await options.openActivity?.(characterRect());
  });
  ipcMain.handle("mimiCompanion:handoff", async (event, accept: unknown) => {
    if (!ownOverlay(event.sender, event.senderFrame) || typeof accept !== "boolean")
      throw new Error("Invalid companion surface");
    const offered = handoff;
    withdrawHandoff();
    publish();
    if (accept && offered) await startChat({ prompt: `请看看我屏幕上的「${offered.app}」窗口。` });
  });
  const onDisplaysChanged = () => {
    normalizeAnchor();
    const point = anchor ?? target ?? screen.getCursorScreenPoint();
    display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    window?.setBounds(display.bounds);
    publish();
  };
  screen.on("display-metrics-changed", onDisplaysChanged);
  screen.on("display-removed", onDisplaysChanged);

  /** Mark wanted, then create/load and wait for the renderer's ready signal. */
  async function present(isCurrent: () => boolean = () => true): Promise<void> {
    if (disposed) throw new Error("角色已关闭");
    presenting = true;
    error = undefined;
    normalizeAnchor();
    window?.setBounds(display.bounds);
    await ensureWindow();
    const readyDeadline = Date.now() + 5000;
    while (presenting && !ready && !error && !disposed && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Withdrawn or superseded meanwhile: the newer request decides what shows.
    if (!presenting || !isCurrent()) return;
    if (disposed || !ready || error || !window || window.isDestroyed()) {
      const reason = error ?? "角色尚未准备好";
      error = reason;
      throw new Error(reason);
    }
    publish();
  }

  /** Synchronously hide and drop the window. Execution activity keeps flowing. */
  function withdraw(): void {
    presenting = false;
    creationEpoch++;
    creating = undefined;
    cancelPreview();
    humanActive = false;
    dragging = false;
    withdrawHandoff();
    const win = window;
    window = undefined;
    ready = false;
    if (win && !win.isDestroyed()) {
      win.hide();
      win.destroy();
    }
  }

  function setSize(value: number): void {
    size = companionSize(value);
    normalizeAnchor();
    if (anchor) window?.setBounds(display.bounds);
    publish();
  }

  async function startPreview(isCurrent: () => boolean = () => true, displayId?: number) {
    cancelPreview();
    if (!presenting || !isCurrent()) return;
    if (humanActive) throw new Error("请先移开角色上的鼠标，再预览动作。");
    chatting = false;
    preview = true;
    if (displayId !== undefined) {
      const selected = screen.getAllDisplays().find((item) => item.id === displayId);
      if (!selected) {
        preview = false;
        throw new Error("所选屏幕已断开");
      }
      display = selected;
      anchor = {
        x: display.workArea.x + display.workArea.width * 0.68 - size * 0.35,
        y: display.workArea.y + display.workArea.height * 0.5 - size / 2,
      };
      pinned = true;
    } else {
      normalizeAnchor();
      display = screen.getDisplayNearestPoint(anchor ?? screen.getCursorScreenPoint());
    }
    window?.setBounds(display.bounds);
    target = undefined;
    if (!isCurrent() || !presenting) {
      cancelPreview();
      return;
    }
    const runId = ++previewSequence;
    const steps = ["observe", "click", "type", "scroll", "idle"] as const;
    steps.forEach((action, index) => {
      previewTimers.push(
        setTimeout(() => {
          if (!preview || disposed || !presenting || !isCurrent()) return;
          const bounds = display.bounds;
          target = {
            x: bounds.x + bounds.width * (index % 2 === 0 ? 0.62 : 0.4),
            y: bounds.y + bounds.height * 0.52,
          };
          if (!pinned) anchor = undefined;
          choreographer.show({
            id: `preview-${runId}-${index}`,
            action,
            phase: "start",
            startedAt: Date.now(),
          });
          publish();
        }, index * 1800),
      );
    });
    const finishPreview = () => {
      // A stale timer from a cancelled or superseded preview does nothing.
      if (!preview || disposed || runId !== previewSequence) return;
      if (humanActive) {
        previewExpiry = setTimeout(finishPreview, 1000);
        return;
      }
      cancelPreview();
      choreographer.show({ id: "idle", action: "idle", phase: "end", startedAt: Date.now() });
      target = undefined;
      publish();
      // The owner decides what is shown next; it never re-shows a closed Mimi.
      if (hooks.onPreviewEnd) hooks.onPreviewEnd();
      else if (!standaloneEnabled) withdraw();
    };
    previewExpiry = setTimeout(finishPreview, 10_000);
    publish();
  }

  return {
    present,
    withdraw,
    setSize,
    startPreview,
    cancelPreview() {
      if (!preview) return;
      cancelPreview();
      target = undefined;
      choreographer.show({ id: "idle", action: "idle", phase: "end", startedAt: Date.now() });
      publish();
    },
    isVisible() {
      return presenting && !!window && !window.isDestroyed() && window.isVisible();
    },
    /** Counts for the badge over her head; undefined or all zero hides it. */
    setAttention(next: MimiCompanionAttention | undefined) {
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
      const normalized = next && {
        running: count(next.running),
        needsAction: count(next.needsAction),
        unread: count(next.unread),
      };
      const value =
        normalized && normalized.running + normalized.needsAction + normalized.unread > 0
          ? normalized
          : undefined;
      if (
        value?.running === attention?.running &&
        value?.needsAction === attention?.needsAction &&
        value?.unread === attention?.unread
      )
        return;
      attention = value;
      publish();
    },
    characterRect,
    /** Visual feet in global DIP, using the size actually drawn (working scale included). */
    feet(): { x: number; y: number } | undefined {
      if (window && !window.isDestroyed() && presenting) {
        const current = state();
        const origin = current.windowOrigin ?? { x: 0, y: 0 };
        return movingFeet(
          { x: origin.x + current.position.x, y: origin.y + current.position.y },
          current.size,
        );
      }
      return anchor ? movingFeet(anchor, size) : undefined;
    },
    /** Stand at `feet` (pinned) the next time the character is shown. */
    placeFeet(feet: { x: number; y: number }) {
      if (!validPoint(feet)) return;
      anchor = movingAnchorForFeet(feet, size);
      pinned = true;
      target = undefined;
      normalizeAnchor();
      window?.setBounds(display.bounds);
      void persist();
      publish();
    },
    status(): MimiCompanionSettings {
      return {
        enabled: presenting,
        size,
        appearance: "mimi-sprite",
        available: true,
        ...(error ? { error } : {}),
      };
    },
    /** Standalone effect lab only. Desktop routes this through the presence owner. */
    async update(value: { enabled?: boolean; size?: number }) {
      if (value.size !== undefined) setSize(value.size);
      if (value.enabled !== undefined) standaloneEnabled = value.enabled;
      if (value.enabled === false) withdraw();
      else if (value.enabled === true) await present();
      publish();
    },
    /** Standalone effect lab only. */
    async preview(displayId?: number) {
      if (!presenting) await present();
      await startPreview(() => true, displayId);
    },
    async close() {
      disposed = true;
      presenting = false;
      cancelPreview();
      syncCapture();
      choreographer.dispose();
      window?.destroy();
      await creating?.catch(() => {});
      window?.destroy();
      ipcMain.removeListener("mimiCompanion:presence", onPresence);
      ipcMain.removeHandler("mimiCompanion:state");
      ipcMain.removeListener("mimiCompanion:ready", onReady);
      ipcMain.removeListener("mimiCompanion:interaction", onInteraction);
      ipcMain.removeListener("mimiCompanion:move", onMove);
      ipcMain.removeListener("mimiCompanion:follow", onFollow);
      ipcMain.removeListener("mimiCompanion:stopComputer", onStopComputer);
      ipcMain.removeListener("mimiCompanion:resumeComputer", onResumeComputer);
      unsubscribeBus();
      unsubscribeGate();
      if (chatRelease) clearTimeout(chatRelease);
      withdrawHandoff();
      ipcMain.removeHandler("mimiCompanion:chat");
      ipcMain.removeHandler("mimiCompanion:handoff");
      ipcMain.removeHandler("mimiCompanion:activity");
      ipcMain.removeHandler("mimiCompanion:chatActive");
      app.removeListener("browser-window-focus", onChatWindowFocus);
      app.removeListener("browser-window-blur", onChatWindowFocus);
      chatSurfaces.clear();
      screen.removeListener("display-metrics-changed", onDisplaysChanged);
      screen.removeListener("display-removed", onDisplaysChanged);
    },
  };
}

export type MimiCompanionHost = Awaited<ReturnType<typeof createMimiCompanionHost>>;
