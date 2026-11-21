import type { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import type { RoomModeAuthority } from "./cc-room/room-mode-authority.js";
import { MAX_EXTERNAL_RUNTIME_TEXT_CHARS } from "./external-runtime-ipc.js";
import { BrowserWindow, ipcMain } from "electron";
import { listBackgroundWorkForUI } from "@cjhyy/code-shell-core/internal";
import type { ReadCcRoom } from "../shared/cc-room-reads.js";
import { AgentBridge } from "./agent-bridge.js";
import { requireRendererLinkedSessionPath } from "./renderer-project-path.js";
import { registerRoomHistoryIpc } from "./cc-room/linked-session-ipc.js";
import { registerLinkedSessionObservationIpc } from "./cc-room/linked-session-observation-ipc.js";
import { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { MobileRemoteOrchestrator } from "./mobile-remote-orchestrator.js";
import { registerRoomModeIpc } from "./cc-room/room-mode-ipc.js";
import { ApprovalBridge } from "./cc-room/approval-bridge.js";
import { createTaskInboxBackgroundHost } from "./task-inbox/task-inbox-background-host.js";
import { createDefaultUsageProviderService } from "./usage-provider-host.js";
import { registerQuotaIpc } from "./quota-ipc.js";

export interface RoomsIpcDeps {
  readCcRoom: ReadCcRoom;
  mainWindows: Set<BrowserWindow>;
  bridge: () => AgentBridge | null;
  approvalBridge: ApprovalBridge;
  roomManager: RoomManager;
  transcriptSubscriptions: TranscriptSubscriptionManager;
  roomModes: RoomModeAuthority;
  mobileOrchestrator: MobileRemoteOrchestrator;
}

/** Desktop rooms, CC/Codex room orchestration and subscription quota routes. */
export function registerRoomsIpc(deps: RoomsIpcDeps) {
  const {
    mainWindows,
    approvalBridge,
    roomManager,
    transcriptSubscriptions,
    roomModes,
    mobileOrchestrator,
  } = deps;
  // ── Rooms (desktop side; same RoomManager the phone uses → dual-ended) ──────
  ipcMain.handle("rooms:list", async () =>
    roomManager.listRooms().map((room) => mobileOrchestrator.roomToPublic(room)),
  );
  ipcMain.handle("rooms:projects", async () => mobileOrchestrator.projectList());
  // rooms:create and ccRoom:openSession choose a room's mode via the Host authority.
  registerRoomModeIpc({
    ipcMain,
    roomManager,
    roomModes,
    roomToPublic: (room) => mobileOrchestrator.roomToPublic(room),
    broadcastRoomState: (roomId) => mobileOrchestrator.broadcastRoomState(roomId),
  });
  ipcMain.handle("rooms:open", async (_e, roomId: string) => roomManager.open(roomId));
  ipcMain.handle("rooms:send", async (_e, roomId: string, text: string) => {
    if (typeof text !== "string" || text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
      throw new Error("invalid room message");
    }
    return roomManager.send(roomId, text);
  });
  ipcMain.handle("rooms:history", async (_e, roomId: string, sinceSeq?: number) =>
    roomManager.getMessages(roomId, sinceSeq ?? 0),
  );

  // ── CC rooms (external `claude` CLI orchestration) ──────────────────────────
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
  registerLinkedSessionObservationIpc({
    ipcMain,
    windows: mainWindows,
    roomManager,
    listBackgroundWork: createTaskInboxBackgroundHost({ worker: () => deps.bridge() }).list,
    readLocalBackgroundWork: () => listBackgroundWorkForUI("task-inbox", { scope: "all" }),
    requirePath: requireRendererLinkedSessionPath,
    subscriptions: transcriptSubscriptions,
    roomMatchesTranscript: (...args) => mobileOrchestrator.roomMatchesTranscript(...args),
    pendingApprovals: (roomId) => approvalBridge.pendingRequests(roomId),
    broadcastRoomState: (roomId) => mobileOrchestrator.broadcastRoomState(roomId),
  });
  ipcMain.handle("ccRoom:send", async (_e, roomId: string, text: string) => {
    if (typeof text !== "string" || text.length > MAX_EXTERNAL_RUNTIME_TEXT_CHARS) {
      throw new Error("invalid room message");
    }
    return roomManager.send(roomId, text);
  });
  ipcMain.handle(
    "ccRoom:respondApproval",
    async (
      _e,
      roomId: string,
      requestId: string,
      decision:
        | { behavior: "allow"; updatedInput?: unknown; answer?: string }
        | { behavior: "deny"; message: string },
    ) => approvalBridge.respond(roomId, requestId, decision),
  );
  registerRoomHistoryIpc(ipcMain, roomManager);
  ipcMain.handle("ccRoom:readHistory", (_e, cwd: string, sessionId: string, limit: number) =>
    deps.readCcRoom("ccRoom/history", { kind: "claude-code", cwd, sessionId, limit }),
  );
  ipcMain.handle("ccRoom:readCodexHistory", (_e, cwd: string, sessionId: string, limit: number) =>
    deps.readCcRoom("ccRoom/history", { kind: "codex", cwd, sessionId, limit }),
  );

  const quota = createDefaultUsageProviderService();
  registerQuotaIpc(ipcMain, () => mainWindows, quota.service, quota.getLegacyQuota);
}
