import type { IpcMain } from "electron";
import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import type { RoomModeAuthority, RoomModeRequester } from "./room-mode-authority.js";
import type {
  CcRoomSettingsRequest,
  CcRoomSettingsState,
  MobilePermissionMode,
} from "../../shared/mobile-remote.js";

type Manager = Pick<
  RoomManager,
  "getRoom" | "roomBusyReason" | "effectiveMode" | "isExecutionBusy"
>;
interface RoomSettingsSources {
  roomManager: Manager;
  roomModes: Pick<RoomModeAuthority, "openSession">;
  broadcastRoomState(roomId: string): void;
}
export function roomSettingsState(roomManager: Manager, roomId: string): CcRoomSettingsState {
  if (typeof roomId !== "string" || !roomId || roomId.length > 512)
    throw new Error("invalid room id");
  const room = roomManager.getRoom(roomId);
  if (!room) throw new Error("CLI 会话不存在。");
  return {
    roomId: room.id,
    sessionId: room.claudeSessionId ?? "",
    cwd: room.cwd,
    kind: room.kind,
    permissionMode: roomManager.effectiveMode(roomId) ?? room.permissionMode,
    modelKey: room.modelKey ?? null,
    observing: room.linkedSessionMode === "observe-only",
    busyReason:
      roomManager.roomBusyReason(roomId) ??
      (roomManager.isExecutionBusy(roomId) ? "retiring" : undefined),
  };
}
export async function openRoomSettings(
  deps: RoomSettingsSources,
  input: {
    sessionId: string;
    cwd: string;
    kind?: "claude-code" | "codex";
    mode: MobilePermissionMode;
    settings?: CcRoomSettingsRequest;
  },
  requester: RoomModeRequester,
) {
  const { sessionId, cwd, kind, mode, settings } = input;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("CLI session id is required");
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
  const result = await deps.roomModes.openSession({
    sessionId,
    cwd,
    kind: kind ?? "claude-code",
    mode,
    ...(settings ? { roomId: settings.roomId, modelKey: settings.modelKey } : {}),
    requester,
  });
  if (result.changed) deps.broadcastRoomState(result.roomId);
  return {
    roomId: result.roomId,
    cwd: deps.roomManager.getRoom(result.roomId)?.cwd,
    status: result.status,
    permissionMode: result.mode,
    modelKey: result.modelKey ?? null,
  };
}
export function registerRoomSettingsIpc(
  ipcMain: Pick<IpcMain, "handle">,
  call: import("../desktop-host/rooms-client.js").NativeRooms["desktop"],
) {
  ipcMain.handle("ccRoom:settingsState", (event, roomId) =>
    call(event, { op: "settings", roomId }),
  );
  ipcMain.handle("ccRoom:openSession", (event, sessionId, cwd, mode, kind, settings) =>
    call(event, { op: "openSession", sessionId, cwd, mode, kind, settings }),
  );
}
