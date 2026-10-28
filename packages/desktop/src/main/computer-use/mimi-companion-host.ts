import { app, BrowserWindow, ipcMain, screen, session, type WebContents } from "electron";
import { readFile, writeFile, mkdir, rename, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import {
  companionSize,
  MIMI_COMPANION_DEFAULT_SIZE,
  MIMI_COMPANION_SCHEME,
  type MimiCompanionSettings,
  type MimiCompanionState,
} from "../../shared/mimi-companion.js";
import { companionPlacement } from "./companion-layout.js";
import { petWidgetAlwaysOnTopLevel } from "../pet/pet-widget-window-state.js";
import { createCuaActivityServer, type CompanionOperation } from "./cua-activity-server.js";

export interface MimiCompanionHostOptions {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  executablePath: string;
  packaged: boolean;
  devUrl?: string;
  isMainWindow(sender: WebContents): boolean;
  openChat(): Promise<void>;
  holdForChat?: boolean;
  log(event: string, data?: Record<string, unknown>): void;
}

/** A full character surface, independent of both the pointer and the chat widget. */
export async function createMimiCompanionHost(options: MimiCompanionHostOptions) {
  const prefsPath = join(options.userDataPath, "mimi-companion.json");
  let enabled = false;
  let size = MIMI_COMPANION_DEFAULT_SIZE;
  let anchor: { x: number; y: number } | undefined;
  let pinned = false;
  let humanActive = false;
  let chatting = false;
  const chatSurfaces = new Set<WebContents>();
  let dragging = false;
  try {
    const saved = JSON.parse(await readFile(prefsPath, "utf8"));
    enabled = saved.enabled === true;
    size = companionSize(saved.size);
    if (validPoint(saved.anchor)) {
      anchor = saved.anchor;
      pinned = true;
    }
  } catch {
    /* First run and invalid preferences use the opt-out default. */
  }

  let window: BrowserWindow | undefined;
  let creating: Promise<void> | undefined;
  let disposed = false;
  let ready = false;
  let error: string | undefined;
  let preview = false;
  let previewSequence = 0;
  let previewTimers: Array<ReturnType<typeof setTimeout>> = [];
  let previewExpiry: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const captures = new Set<string>();
  let captureBarrier: Promise<void> = Promise.resolve();
  const active = new Map<string, CompanionOperation>();
  let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (anchor) display = screen.getDisplayNearestPoint(anchor);
  let target: { x: number; y: number } | undefined;
  let avoidRect: { x: number; y: number; width: number; height: number } | undefined;
  let activity: MimiCompanionState["activity"] = {
    id: "idle",
    action: "idle",
    phase: "end",
    startedAt: Date.now(),
  };
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
    const placement = companionPlacement(
      bounds,
      size,
      target,
      humanActive || chatting || pinned ? undefined : avoidRect,
    );
    if (anchor) placement.position = { x: anchor.x - bounds.x, y: anchor.y - bounds.y };
    return {
      enabled,
      visible:
        (enabled || preview) &&
        (captures.size === 0 || humanActive || chatting) &&
        !placement.obstructed &&
        !disposed,
      appearance: "mimi-sprite",
      size,
      modelUrl: `${MIMI_COMPANION_SCHEME}://assets/Hiyori/Hiyori.model3.json`,
      coreUrl: `${MIMI_COMPANION_SCHEME}://assets/Core/live2dcubismcore.min.js`,
      ...placement,
      windowOrigin: { x: bounds.x, y: bounds.y },
      humanActive: humanActive || chatting,
      avoidInput: !!avoidRect && !humanActive && !chatting && !pinned,
      pinned,
      activity,
      preview,
    };
  };

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

  let saveQueue = Promise.resolve();
  const persist = () => {
    const saved = JSON.stringify({ enabled, size, ...(pinned && anchor ? { anchor } : {}) });
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(prefsPath), { recursive: true });
        await writeFile(prefsPath + ".tmp", saved, { mode: 0o600 });
        await rename(prefsPath + ".tmp", prefsPath);
      });
    return saveQueue;
  };

  function publish() {
    if (!window || window.isDestroyed() || disposed) return;
    const next = state();
    window.webContents.send("mimiCompanion:state", next);
    if (next.visible && ready && !error) {
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
    creating = (async () => {
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
      if (disposed || (!enabled && !preview)) return;
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
        error = "角色显示进程已退出，请关闭再开启。";
        if (!win.isDestroyed()) win.destroy();
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
        error = "角色显示未能加载，请关闭再开启。";
        options.log("mimi_companion_load_failed", { error: String(failure) });
        if (!win.isDestroyed()) win.destroy();
      }
    })().finally(() => {
      creating = undefined;
    });
    return creating;
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
  ) {
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
    if (!target || pinned) return;
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

  async function receive(event: CompanionOperation) {
    if (disposed) return;
    if (event.phase === "update") {
      const previous = active.get(event.id);
      if (!previous || previous.capture || !event.target) return;
      active.set(event.id, { ...previous, target: event.target, avoidRect: event.avoidRect });
      if (humanActive || chatting || activity.id !== event.id) return;
      // Native cursor snapshots refine the existing operation's target; they
      // must not replay its gesture or release a capture held by another call.
      const retainedInput =
        event.action === "key" &&
        target &&
        avoidRect &&
        target.x === event.target.x &&
        target.y === event.target.y
          ? avoidRect
          : undefined;
      placeAt(event.target, event.avoidRect ?? retainedInput);
      publish();
      return;
    }
    if (event.phase === "start") {
      active.set(event.id, {
        ...event,
        target: event.targetSource === "native-cursor" ? event.target : undefined,
      });
      if (event.capture) {
        const wasVisible = window?.isVisible() ?? false;
        captures.add(event.id);
        publish();
        // Acknowledge only after the hidden window has had time to leave the
        // compositor. The proxy bounds this wait and never retries input.
        if (wasVisible) captureBarrier = new Promise((resolve) => setTimeout(resolve, 50));
        await captureBarrier;
        return;
      }
      // Read-only metadata probes must not erase the input target or cut off
      // the gesture that the input is still completing.
      if (event.action === "observe") return;
      if (humanActive || chatting) return;
      cancelPreview();
      if (idleTimer) clearTimeout(idleTimer);
      // Cached AX/screenshot geometry may already be stale when input starts.
      // Wait for this operation's native cursor update before following it.
      if (event.action !== "key")
        placeAt(event.targetSource === "native-cursor" ? event.target : undefined);
      activity = { id: event.id, action: event.action, phase: "start", startedAt: Date.now() };
      if (enabled)
        void ensureWindow().catch((failure) => {
          options.log("mimi_companion_load_failed", { error: String(failure) });
        });
    } else {
      active.delete(event.id);
      captures.delete(event.id);
      if (activity.id === event.id) {
        activity = { ...activity, phase: "end", ...(event.failed ? { action: "error" } : {}) };
        idleTimer = setTimeout(
          () => {
            if (activity.id !== event.id || disposed) return;
            const next = [...active.values()]
              .reverse()
              .find((candidate) => !candidate.capture && candidate.action !== "observe");
            activity = next
              ? { id: next.id, action: next.action, phase: "start", startedAt: Date.now() }
              : { id: "idle", action: "idle", phase: "end", startedAt: Date.now() };
            if (next && !humanActive && !chatting) placeAt(next.target, next.avoidRect);
            publish();
          },
          event.failed ? 2000 : 700,
        );
      }
    }
    publish();
  }

  const activityServer = await createCuaActivityServer(receive);
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
    if (idleTimer) clearTimeout(idleTimer);
    activity = { id: "human", action: "idle", phase: "end", startedAt: Date.now() };
    target = undefined;
    avoidRect = undefined;
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
    if (chatting) stopPresentation();
    publish();
  };
  // A chat hold belongs to the visible, focused chat page. Leaving the page or
  // switching back to work releases it; dragging still keeps the saved anchor.
  ipcMain.handle("mimiCompanion:chatActive", (event, value: unknown) => {
    if (
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !options.isMainWindow(event.sender) ||
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
      if (phase === "begin") dragging = true;
      stopPresentation();
      window?.setIgnoreMouseEvents(false);
    } else {
      if (phase === "leave" && dragging) return;
      if (phase === "end") {
        dragging = false;
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
    if (display.id !== next.id) {
      display = next;
      window?.setBounds(display.bounds);
    }
    publish();
  };
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
  ipcMain.on("mimiCompanion:interaction", onInteraction);
  ipcMain.on("mimiCompanion:move", onMove);
  ipcMain.on("mimiCompanion:follow", onFollow);
  ipcMain.handle("mimiCompanion:chat", async (event) => {
    if (!ownOverlay(event.sender, event.senderFrame)) throw new Error("Invalid companion surface");
    pinned = true;
    chatting = options.holdForChat !== false;
    stopPresentation();
    humanActive = false;
    dragging = false;
    window?.setIgnoreMouseEvents(true, { forward: true });
    window?.setFocusable(false);
    await persist();
    try {
      await options.openChat();
    } catch (failure) {
      chatting = false;
      publish();
      throw failure;
    }
    syncChatFocus();
    publish();
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
  if (enabled) await ensureWindow();

  return {
    status(): MimiCompanionSettings {
      return {
        enabled,
        size,
        appearance: "mimi-sprite",
        available: true,
        ...(error ? { error } : {}),
      };
    },
    mcpProxy: {
      command: options.executablePath,
      entryPath: join(options.appPath, "out", "main", "cua-activity-proxy.mjs"),
      socketPath: activityServer.socketPath,
      token: activityServer.token,
    },
    async update(value: { enabled?: boolean; size?: number }) {
      const next = { enabled: value.enabled ?? enabled, size: companionSize(value.size ?? size) };
      enabled = next.enabled;
      size = next.size;
      normalizeAnchor();
      if (anchor) window?.setBounds(display.bounds);
      await persist();
      cancelPreview();
      if (!enabled) {
        stopPresentation();
        humanActive = false;
        chatting = false;
        dragging = false;
        window?.destroy();
        error = undefined;
      } else await ensureWindow();
      publish();
    },
    async preview(displayId?: number) {
      cancelPreview();
      if (humanActive) return;
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
      await ensureWindow();
      const readyDeadline = Date.now() + 5000;
      while (!ready && !error && !disposed && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!ready || disposed) {
        cancelPreview();
        throw new Error(error ?? "角色尚未准备好");
      }
      const runId = ++previewSequence;
      const steps = ["observe", "click", "type", "scroll", "idle"] as const;
      steps.forEach((action, index) => {
        previewTimers.push(
          setTimeout(() => {
            if (!preview || disposed) return;
            const bounds = display.bounds;
            target = {
              x: bounds.x + bounds.width * (index % 2 === 0 ? 0.62 : 0.4),
              y: bounds.y + bounds.height * 0.52,
            };
            if (!pinned) anchor = undefined;
            activity = {
              id: `preview-${runId}-${index}`,
              action,
              phase: "start",
              startedAt: Date.now(),
            };
            publish();
          }, index * 1800),
        );
      });
      const finishPreview = () => {
        if (humanActive) {
          previewExpiry = setTimeout(finishPreview, 1000);
          return;
        }
        cancelPreview();
        activity = { id: "idle", action: "idle", phase: "end", startedAt: Date.now() };
        target = undefined;
        if (!enabled) window?.destroy();
        else publish();
      };
      previewExpiry = setTimeout(finishPreview, 10_000);
      publish();
    },
    async close() {
      disposed = true;
      cancelPreview();
      if (idleTimer) clearTimeout(idleTimer);
      window?.destroy();
      await creating?.catch(() => {});
      window?.destroy();
      ipcMain.removeHandler("mimiCompanion:state");
      ipcMain.removeListener("mimiCompanion:ready", onReady);
      ipcMain.removeListener("mimiCompanion:interaction", onInteraction);
      ipcMain.removeListener("mimiCompanion:move", onMove);
      ipcMain.removeListener("mimiCompanion:follow", onFollow);
      ipcMain.removeHandler("mimiCompanion:chat");
      ipcMain.removeHandler("mimiCompanion:chatActive");
      app.removeListener("browser-window-focus", onChatWindowFocus);
      app.removeListener("browser-window-blur", onChatWindowFocus);
      chatSurfaces.clear();
      screen.removeListener("display-metrics-changed", onDisplaysChanged);
      screen.removeListener("display-removed", onDisplaysChanged);
      await activityServer.close();
      await persist().catch(() => {});
    },
  };
}

export type MimiCompanionHost = Awaited<ReturnType<typeof createMimiCompanionHost>>;
