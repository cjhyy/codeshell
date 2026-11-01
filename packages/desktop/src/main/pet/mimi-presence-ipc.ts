import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  MIMI_COMPANION_MAX_SIZE,
  MIMI_COMPANION_MIN_SIZE,
  type MimiCompanionSettings,
} from "../../shared/mimi-companion.js";
import {
  isMimiPresenceMode,
  type MimiPresencePatch,
  type MimiPresenceSnapshot,
} from "../../shared/mimi-presence.js";

export interface MimiPresenceOwner {
  snapshot(): MimiPresenceSnapshot;
  set(patch: MimiPresencePatch): Promise<boolean>;
  preview(): Promise<void>;
  retry(): Promise<boolean>;
}

export interface MimiPresenceIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  owner: MimiPresenceOwner;
  /** Trusted Desktop main windows (settings, account menu, Mimi page). */
  isMainWindow(sender: WebContents): boolean;
  /** The docked widget window that is currently alive. */
  isDockedSurface(sender: WebContents): boolean;
}

/** The legacy "is the widget visible" answer: Mimi is on and not failed. */
export function effectiveMimiVisible(snapshot: MimiPresenceSnapshot): boolean {
  return snapshot.visible && !(snapshot.effectiveMode === "docked" && snapshot.dockedError);
}

export function parseMimiPresencePatch(raw: unknown): MimiPresencePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("无效的 Mimi 设置。");
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "visible" && key !== "mode" && key !== "size") ||
    (input.visible !== undefined && typeof input.visible !== "boolean") ||
    (input.mode !== undefined && !isMimiPresenceMode(input.mode)) ||
    (input.size !== undefined &&
      (typeof input.size !== "number" ||
        !Number.isFinite(input.size) ||
        input.size < MIMI_COMPANION_MIN_SIZE ||
        input.size > MIMI_COMPANION_MAX_SIZE))
  ) {
    throw new Error("无效的 Mimi 设置。");
  }
  return input as MimiPresencePatch;
}

const mainFrame = (event: IpcMainInvokeEvent) =>
  !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame;

/**
 * Presence IPC. Settings changes come only from a main window; the docked
 * widget may read state and close itself (legacy `pet:widget-visible false`).
 * Every path goes through the single owner, so no entry can show a second Mimi.
 */
export function registerMimiPresenceIpc(deps: MimiPresenceIpcDeps): void {
  const requireMain = (event: IpcMainInvokeEvent) => {
    if (!mainFrame(event) || !deps.isMainWindow(event.sender))
      throw new Error("Mimi 设置只能由桌面主窗口修改。");
  };
  const requireReader = (event: IpcMainInvokeEvent) => {
    if (
      !mainFrame(event) ||
      !(deps.isMainWindow(event.sender) || deps.isDockedSurface(event.sender))
    )
      throw new Error("无效的 Mimi 调用方。");
  };

  deps.ipcMain.handle("mimi:presence-get", (event) => {
    requireReader(event);
    return deps.owner.snapshot();
  });
  deps.ipcMain.handle("mimi:presence-set", async (event, raw: unknown) => {
    requireMain(event);
    const patch = parseMimiPresencePatch(raw);
    await deps.owner.set(patch);
    return deps.owner.snapshot();
  });
  deps.ipcMain.handle("mimi:presence-preview", async (event) => {
    requireMain(event);
    await deps.owner.preview();
    return deps.owner.snapshot();
  });
  deps.ipcMain.handle("mimi:presence-retry", async (event) => {
    requireMain(event);
    await deps.owner.retry();
    return deps.owner.snapshot();
  });

  // ---- legacy aliases, kept for existing callers --------------------------
  deps.ipcMain.handle("pet:widget-visible-get", (event) => {
    requireReader(event);
    return effectiveMimiVisible(deps.owner.snapshot());
  });
  deps.ipcMain.handle("pet:widget-visible", async (event, visible: unknown) => {
    if (typeof visible !== "boolean") throw new Error("pet:widget-visible requires boolean");
    requireReader(event);
    // The widget may only close itself; showing is a main-window decision.
    if (visible && !deps.isMainWindow(event.sender)) throw new Error("无效的 Mimi 调用方。");
    await deps.owner.set({ visible });
    return { ok: true as const };
  });
}

/**
 * computerUse:setCompanion/previewCompanion now act on the same owner:
 * enabling the companion means "show Mimi in moving mode"; disabling it hides
 * Mimi only when moving is the chosen form.
 */
export function legacyCompanionSettings(owner: MimiPresenceOwner) {
  return {
    status(): MimiCompanionSettings {
      const snapshot = owner.snapshot();
      return {
        enabled: snapshot.visible && snapshot.effectiveMode === "moving",
        size: snapshot.size,
        appearance: "mimi-sprite",
        available: snapshot.movingAvailable,
        ...(snapshot.movingError
          ? { error: snapshot.movingError }
          : !snapshot.movingAvailable && snapshot.movingUnavailableReason
            ? { error: snapshot.movingUnavailableReason }
            : {}),
      };
    },
    async update(value: { enabled?: boolean; size?: number }): Promise<void> {
      const patch: MimiPresencePatch = {};
      if (value.size !== undefined) patch.size = value.size;
      if (value.enabled === true) {
        patch.visible = true;
        patch.mode = "moving";
      } else if (value.enabled === false && owner.snapshot().mode === "moving") {
        patch.visible = false;
      }
      if (Object.keys(patch).length > 0) await owner.set(patch);
    },
    preview(): Promise<void> {
      return owner.preview();
    },
  };
}
