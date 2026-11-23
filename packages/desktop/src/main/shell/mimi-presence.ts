import { app, BrowserWindow, ipcMain, Menu, screen, shell } from "electron";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import { dlog } from "../desktop-logger.js";
import {
  initializeDesktopComputerUse,
  getComputerUseInputControl,
  getMimiCompanion,
  mimiMovingUnavailableReason,
} from "../computer-use/desktop-setup.js";
import { petWidgetMenuTemplate } from "../pet/pet-widget-menu.js";
import { createPetWindows } from "./pet-windows.js";
import { petWidgetWindowStatePath } from "../pet/pet-widget-window-state.js";
import { createPetWidgetSurface, type PetWidgetSurface } from "../pet/pet-widget-surface.js";
import { createMimiBubbleHost, type MimiBubbleHost } from "../pet/mimi-bubble-host.js";
import { MimiPresenceController } from "../pet/mimi-presence-controller.js";
import {
  createMimiPresenceWriter,
  defaultMimiPresenceState,
  loadMimiPresenceState,
  MIMI_PRESENCE_FILE,
  type MimiPresenceLoadResult,
} from "../pet/mimi-presence-state.js";
import {
  effectiveMimiVisible,
  legacyCompanionSettings,
  registerMimiPresenceIpc,
  type MimiPresenceOwner,
} from "../pet/mimi-presence-ipc.js";
import type { MimiPresenceSnapshot } from "../../shared/mimi-presence.js";

/** Owns all native Mimi surfaces and their window, input and presence lifecycle. */
export function createMimiPresenceShell(deps: {
  mainDirectory: string;
  navigation: Pick<AppRendererNavigation, "bind">;
  mainWindows: Set<BrowserWindow>;
  petIpcReady: Promise<void>;
  attach(window: BrowserWindow): void;
  openOverview(request?: unknown): Promise<void>;
  cwd(): string;
}) {
  const { mainWindows, petIpcReady } = deps;
  /** Docked Mimi (the pet widget). Created once the app is ready. */
  let petWidgetSurface: PetWidgetSurface | null = null;
  /** Moving Mimi's chat and work list: the docked widget's panels, opened beside her. */
  let mimiBubble: MimiBubbleHost | null = null;
  /** The single owner of Mimi's desktop presence (docked/moving, never both). */
  let mimiPresence: MimiPresenceController | null = null;
  let resolveMimiPresence: ((controller: MimiPresenceController) => void) | null = null;
  const mimiPresenceReady = new Promise<MimiPresenceController>((resolveReady) => {
    resolveMimiPresence = resolveReady;
  });
  const initialMimiPresenceSnapshot: MimiPresenceSnapshot = {
    visible: false,
    mode: "docked",
    size: defaultMimiPresenceState().size,
    appearance: defaultMimiPresenceState().appearance,
    effectiveMode: "docked",
    shown: null,
    movingAvailable: false,
    movingUnavailableReason: "正在初始化",
    previewing: false,
  };
  /** Requests made before startup finishes wait for the owner instead of failing. */
  const mimiPresenceOwner: MimiPresenceOwner = {
    snapshot: () => mimiPresence?.snapshot() ?? initialMimiPresenceSnapshot,
    set: async (patch) => (await mimiPresenceReady).set(patch),
    preview: async () => (await mimiPresenceReady).preview(),
    retry: async () => (await mimiPresenceReady).retry(),
  };
  const petWidgetWindow = (): BrowserWindow | null =>
    (petWidgetSurface?.window() as BrowserWindow | null | undefined) ?? null;
  /** Mimi windows besides the main ones that render pet chat and history. */
  const petSurfaceWindows = (): BrowserWindow[] =>
    [petWidgetWindow(), mimiBubble?.surface.window() as BrowserWindow | null | undefined].filter(
      (win): win is BrowserWindow => !!win,
    );
  function isMainWindowSender(sender: Electron.WebContents): boolean {
    return [...mainWindows].some(
      (window) => !window.isDestroyed() && window.webContents === sender,
    );
  }

  function broadcastMimiPresence(snapshot: MimiPresenceSnapshot): void {
    mimiBubble?.sync(snapshot);
    const visible = effectiveMimiVisible(snapshot);
    for (const win of mainWindows) {
      if (win.isDestroyed()) continue;
      win.webContents.send("mimi:presence-changed", snapshot);
      win.webContents.send("pet:widget-visibility-changed", visible);
    }
    // The docked widget draws the chosen character too.
    for (const win of petSurfaceWindows()) win.webContents.send("mimi:presence-changed", snapshot);
  }

  /**
   * Load (or migrate) the unified presence file and create its owner. Neither
   * form is shown until `startMimiPresence` runs after computer use is composed.
   */
  async function createMimiPresence(): Promise<MimiPresenceController> {
    const paths = {
      statePath: join(codeShellHome(), "desktop", MIMI_PRESENCE_FILE),
      legacyCompanionPath: join(app.getPath("userData"), "mimi-companion.json"),
      legacyWidgetPath: petWidgetWindowStatePath(),
    };
    const loaded: MimiPresenceLoadResult = await loadMimiPresenceState(paths).catch((error) => {
      dlog("main", "mimi-presence.load.failed", { error: String(error) });
      return { state: defaultMimiPresenceState(), source: "default" as const };
    });
    if (loaded.quarantined) dlog("main", "mimi-presence.quarantined", { copy: loaded.quarantined });
    const write = createMimiPresenceWriter(paths.statePath);
    const petWindows = createPetWindows(deps.mainDirectory, deps.navigation, deps.attach);
    const surface = createPetWidgetSurface({
      platform: process.platform,
      screen: {
        getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
        getPrimaryDisplay: () => screen.getPrimaryDisplay(),
        on: (event, listener) => screen.on(event as "display-removed", listener),
        removeListener: (event, listener) =>
          screen.removeListener(event as "display-removed", listener),
      },
      ready: () => petIpcReady,
      createWindow: petWindows.create,
      load: (win) => petWindows.load(win as BrowserWindow),
      loadAnchor: () => mimiPresence?.anchor("docked"),
      saveAnchor: (anchor) => mimiPresence?.rememberAnchor("docked", anchor),
      onFailure: (error) => mimiPresence?.surfaceFailed("docked", error),
      log: (event, data) => dlog("main", event, data),
    });
    petWidgetSurface = surface;
    mimiBubble = createMimiBubbleHost({
      platform: process.platform,
      screen,
      ipcMain,
      ready: () => petIpcReady,
      createWindow: petWindows.create,
      load: (win) => petWindows.load(win as BrowserWindow, "bubble"),
      companion: getMimiCompanion,
      openOverview: deps.openOverview,
      log: (event, data) => dlog("main", event, data),
    });
    const controller = new MimiPresenceController({
      initial: loaded.state,
      docked: surface,
      save: write,
      onChange: broadcastMimiPresence,
      log: (event, data) => dlog("main", event, data),
    });
    mimiPresence = controller;
    // One-time migration: write the new file; legacy files stay untouched for rollback.
    if (loaded.source === "migrated") {
      dlog("main", "mimi-presence.migrated", {
        visible: loaded.state.visible,
        mode: loaded.state.mode,
        size: loaded.state.size,
      });
      void write(loaded.state).catch(() => {});
    }
    resolveMimiPresence?.(controller);
    resolveMimiPresence = null;
    return controller;
  }

  /** Present only after pet IPC and computer use are both composed: no startup flash. */
  function startMimiPresence(controller: MimiPresenceController): void {
    void petIpcReady.then(() =>
      controller.start({
        surface: getMimiCompanion(),
        unavailableReason: mimiMovingUnavailableReason(),
      }),
    );
  }

  async function start() {
    // One owner for Mimi's desktop presence; nothing is shown until it starts.
    const presence = await createMimiPresence();
    // Register the opt-in host before the first worker receives its MCP environment.
    try {
      await initializeDesktopComputerUse({
        app,
        openCompanionChat: async (request, near) =>
          mimiBubble?.open("chat", near, request?.prompt, request?.send),
        openCompanionActivity: async (near) => mimiBubble?.open("activity", near),
        onCompanionMoved: (near) => mimiBubble?.surface.follow(near),
        ipcMain,
        openExternal: (url) => shell.openExternal(url),
        isMainWindow: isMainWindowSender,
        // The docked inline chat is a Mimi chat too: it may hold foreground input.
        isCompanionChatSurface: (sender) =>
          isMainWindowSender(sender) ||
          Boolean(petWidgetSurface?.owns(sender.id) || mimiBubble?.surface.owns(sender.id)),
        companionPresence: {
          initial: { size: presence.persisted().size, anchor: presence.anchor("moving") },
          onAnchorChange: (anchor) => presence.rememberAnchor("moving", anchor),
          onFailure: (error) => presence.surfaceFailed("moving", error),
          onPreviewEnd: () => presence.previewEnded(),
          onCaptureChange: (capturing) => presence.setCaptureActive(capturing),
          request: (patch) => void presence.set(patch),
        },
        companionSettings: legacyCompanionSettings(mimiPresenceOwner),
        cwd: deps.cwd,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        env: process.env,
        log: (event, data) => dlog("computer-use", event, data),
      });
    } finally {
      startMimiPresence(presence);
    }
  }
  function registerIpc() {
    // Every Mimi entry — account menu, Mimi settings, legacy widget/companion IPC
    // and both surfaces' menus — goes through the one presence owner.
    registerMimiPresenceIpc({
      ipcMain,
      owner: mimiPresenceOwner,
      isMainWindow: isMainWindowSender,
      isDockedSurface: (sender) => Boolean(petWidgetSurface?.owns(sender.id)),
    });

    ipcMain.on("pet:widget-context-menu", (event) => {
      const win = petWidgetWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      const presence = mimiPresenceOwner.snapshot();
      const input = getComputerUseInputControl();
      const inputStatus = input?.status();
      const template = petWidgetMenuTemplate({
        locale: app.getLocale(),
        movingAvailable: presence.movingAvailable,
        movingUnavailableReason: presence.movingUnavailableReason,
        computerInput:
          input && inputStatus
            ? { resume: inputStatus.stopped || inputStatus.foregroundHeld }
            : undefined,
        actions: {
          open: () => void deps.openOverview(),
          switchToMoving: () => void mimiPresenceOwner.set({ mode: "moving" }),
          stopOrResumeComputer: (resume) => {
            if (resume) input?.resume();
            else input?.stop();
            dlog("computer-use", resume ? "computer_input_resumed" : "computer_input_stopped", {
              source: "docked-mimi",
            });
          },
          close: () => void mimiPresenceOwner.set({ visible: false }),
        },
      });
      Menu.buildFromTemplate(template).popup({ window: win });
    });

    ipcMain.on("pet:widget-move", (event, rawPosition: unknown) => {
      if (!petWidgetSurface?.owns(event.sender.id)) return;
      petWidgetSurface.moveTo(rawPosition);
    });

    ipcMain.handle("pet:widget-expanded", (event, expanded: unknown) => {
      if (typeof expanded !== "boolean") throw new Error("pet:widget-expanded requires boolean");
      if (petWidgetSurface?.owns(event.sender.id)) {
        petWidgetSurface.setSurfaceMode(expanded ? "expanded" : "collapsed");
      } else if (mimiBubble?.surface.owns(event.sender.id))
        mimiBubble.surface.setExpanded(expanded);
      return { ok: true as const };
    });

    ipcMain.handle("pet:widget-surface", (event, mode: unknown) => {
      if (mode !== "collapsed" && mode !== "expanded") {
        throw new Error("pet:widget-surface requires collapsed or expanded");
      }
      if (petWidgetSurface?.owns(event.sender.id)) {
        petWidgetSurface.setSurfaceMode(mode);
      } else if (mimiBubble?.surface.owns(event.sender.id)) {
        mimiBubble.surface.setExpanded(mode === "expanded");
      }
      return { ok: true as const };
    });

    ipcMain.handle("pet:widget-open-overview", async (_event, request?: unknown) => {
      await deps.openOverview(request);
      return { ok: true as const };
    });
  }
  return {
    windows: petSurfaceWindows,
    registerIpc,
    start,
    dispose() {
      const saved = mimiPresence?.dispose();
      petWidgetSurface?.dispose();
      mimiBubble?.surface.dispose();
      return saved;
    },
  };
}
