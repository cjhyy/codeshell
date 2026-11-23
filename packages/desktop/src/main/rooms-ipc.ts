import { registerRoomSettingsIpc } from "./cc-room/room-settings-ipc.js";
import { registerLinkedSessionObservationIpc } from "./cc-room/linked-session-observation-ipc.js";
import { ipcMain, type BrowserWindow } from "electron";
import type { NativeRooms } from "./desktop-host/rooms-client.js";
import type { ReadCcRoom } from "../shared/cc-room-reads.js";
import type { RoomHistoryAccess } from "../shared/room-history.js";
import type { MobileRemoteOrchestrator } from "./mobile-remote-orchestrator.js";
import { registerRoomHistoryIpc } from "./cc-room/linked-session-ipc.js";
import { createDefaultUsageProviderService } from "./usage-provider-host.js";
import { registerQuotaIpc } from "./quota-ipc.js";

export function registerRoomsIpc(deps: {
  readCcRoom: ReadCcRoom;
  roomHistory: RoomHistoryAccess;
  mainWindows: Set<BrowserWindow>;
  hostedRooms: NativeRooms;
  mobileOrchestrator: MobileRemoteOrchestrator;
}) {
  const { hostedRooms: rooms, mainWindows } = deps;
  registerRoomSettingsIpc(ipcMain, (event, action) => rooms.desktop(event, action));
  registerLinkedSessionObservationIpc(ipcMain, (event, action) => rooms.desktop(event, action));
  ipcMain.handle("rooms:list", (event) => rooms.desktop(event, { op: "list" }));
  ipcMain.handle("rooms:projects", () => deps.mobileOrchestrator.projectList());
  ipcMain.handle("rooms:create", (event, input) => rooms.desktop(event, { op: "create", input }));
  ipcMain.handle("rooms:open", (event, roomId) => rooms.desktop(event, { op: "open", roomId }));
  ipcMain.handle("rooms:send", (event, roomId, text) =>
    rooms.desktop(event, { op: "send", roomId, text }),
  );
  ipcMain.handle("rooms:history", (_event, roomId, sinceSeq) =>
    deps.roomHistory.getMessages(roomId, sinceSeq ?? 0),
  );
  ipcMain.handle("ccRoom:send", (event, roomId, text) =>
    rooms.desktop(event, { op: "send", roomId, text }),
  );
  ipcMain.handle("ccRoom:respondApproval", (event, roomId, requestId, decision) =>
    rooms.desktop(event, { op: "respond", roomId, requestId, decision }),
  );
  ipcMain.handle("ccRoom:probe", (_e, force?: boolean) =>
    deps.readCcRoom("ccRoom/probe", { kind: "claude-code", force }),
  );
  ipcMain.handle("ccRoom:codexProbe", (_e, force?: boolean) =>
    deps.readCcRoom("ccRoom/probe", { kind: "codex", force }),
  );
  ipcMain.handle("ccRoom:listSessions", (_e, cwd: string, all?: boolean) =>
    deps.readCcRoom("ccRoom/sessions", { kind: "claude-code", cwd, all }),
  );
  ipcMain.handle("ccRoom:listCodexSessions", (_e, cwd: string, all?: boolean) =>
    deps.readCcRoom("ccRoom/sessions", { kind: "codex", cwd, all }),
  );
  registerRoomHistoryIpc(ipcMain, deps.roomHistory);
  ipcMain.handle("ccRoom:readHistory", (_e, cwd: string, sessionId: string, limit: number) =>
    deps.readCcRoom("ccRoom/history", { kind: "claude-code", cwd, sessionId, limit }),
  );
  ipcMain.handle("ccRoom:readCodexHistory", (_e, cwd: string, sessionId: string, limit: number) =>
    deps.readCcRoom("ccRoom/history", { kind: "codex", cwd, sessionId, limit }),
  );

  const quota = createDefaultUsageProviderService();
  registerQuotaIpc(ipcMain, () => mainWindows, quota.service, quota.getLegacyQuota);
}
