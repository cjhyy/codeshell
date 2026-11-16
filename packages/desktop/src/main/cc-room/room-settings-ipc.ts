import type { IpcMain } from "electron";
import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { RoomModeAuthority } from "./room-mode-authority.js";
import type {
  CcRoomSettingsRequest,
  CcRoomSettingsState,
  MobilePermissionMode,
} from "../../shared/mobile-remote.js";

/** Native settings use the same exact-room authority and handoff as the Web client. */
export function registerRoomSettingsIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  roomManager: Pick<
    RoomManager,
    "getRoom" | "roomBusyReason" | "effectiveMode" | "isExecutionBusy"
  >;
  roomModes: Pick<RoomModeAuthority, "openSession">;
  broadcastRoomState(roomId: string): void;
}) {
  deps.ipcMain.handle("ccRoom:settingsState", (_event, roomId: string): CcRoomSettingsState => {
    if (typeof roomId !== "string" || !roomId || roomId.length > 512)
      throw new Error("invalid room id");
    const room = deps.roomManager.getRoom(roomId);
    if (!room) throw new Error("CLI 会话不存在。");
    return {
      roomId: room.id,
      sessionId: room.claudeSessionId ?? "",
      cwd: room.cwd,
      kind: room.kind,
      permissionMode: deps.roomManager.effectiveMode(roomId) ?? room.permissionMode,
      modelKey: room.modelKey ?? null,
      observing: room.linkedSessionMode === "observe-only",
      busyReason:
        deps.roomManager.roomBusyReason(roomId) ??
        (deps.roomManager.isExecutionBusy(roomId) ? "retiring" : undefined),
    };
  });
  deps.ipcMain.handle(
    "ccRoom:openSession",
    async (
      event,
      sessionId: string,
      cwd: string,
      mode: MobilePermissionMode,
      kind?: "claude-code" | "codex",
      settings?: CcRoomSettingsRequest,
    ) => {
      if (typeof sessionId !== "string" || !sessionId)
        throw new Error("CLI session id is required");
      if (mode !== "default" && mode !== "acceptEdits" && mode !== "bypassPermissions")
        throw new Error("invalid permission mode");
      if (kind !== undefined && kind !== "claude-code" && kind !== "codex")
        throw new Error("invalid CLI kind");
      if (
        settings !== undefined &&
        (!settings ||
          typeof settings !== "object" ||
          Array.isArray(settings) ||
          typeof settings.roomId !== "string" ||
          !settings.roomId ||
          settings.roomId.length > 512 ||
          (settings.modelKey !== undefined &&
            settings.modelKey !== null &&
            (typeof settings.modelKey !== "string" ||
              settings.modelKey.length > 512 ||
              !/^(codex|claude-code)\/[^\r\n\0]+$/.test(settings.modelKey))))
      )
        throw new Error("invalid CLI settings request");
      const sender = event.sender;
      const result = await deps.roomModes.openSession({
        sessionId,
        cwd,
        kind: kind ?? "claude-code",
        mode,
        ...(settings ? { roomId: settings.roomId, modelKey: settings.modelKey } : {}),
        requester: {
          key: `desktop:${sender.id}`,
          channel: "desktop",
          ownerWebContentsId: sender.id,
          assertCurrent: () => {
            if (sender.isDestroyed()) throw new Error("requester window closed");
          },
        },
      });
      if (result.changed) deps.broadcastRoomState(result.roomId);
      return {
        roomId: result.roomId,
        cwd: deps.roomManager.getRoom(result.roomId)?.cwd,
        status: result.status,
        permissionMode: result.mode,
        modelKey: result.modelKey ?? null,
      };
    },
  );
}
