import type { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import type { RoomModeAuthority } from "./cc-room/room-mode-authority.js";
import { MAX_EXTERNAL_RUNTIME_TEXT_CHARS } from "./external-runtime-ipc.js";
import { BrowserWindow, ipcMain } from "electron";
import {
  checkQuota,
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  listRelatedClaudeSessions,
  listRelatedCodexSessions,
  probeClaudeCli,
  probeCodexCli,
  readCodexRecentHistory,
  readRecentHistory,
  resolveQuotaCredentials,
  type QuotaResult,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { AgentBridge } from "./agent-bridge.js";
import {
  requireRendererLinkedSessionPath,
  requireRendererProjectPath,
} from "./renderer-project-path.js";
import { registerRoomHistoryIpc } from "./cc-room/linked-session-ipc.js";
import { registerLinkedSessionObservationIpc } from "./cc-room/linked-session-observation-ipc.js";
import { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";
import { MobileRemoteOrchestrator } from "./mobile-remote-orchestrator.js";
import { registerRoomModeIpc } from "./cc-room/room-mode-ipc.js";
import { ApprovalBridge } from "./cc-room/approval-bridge.js";
import { createTaskInboxBackgroundHost } from "./task-inbox/task-inbox-background-host.js";

export interface RoomsIpcDeps {
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
  ipcMain.handle("ccRoom:probe", async (_e, force?: boolean) => probeClaudeCli(Boolean(force)));
  ipcMain.handle("ccRoom:codexProbe", async (_e, force?: boolean) => probeCodexCli(Boolean(force)));
  // Bounded by default (recent 2 weeks AND ≤20) so a project with lots of history
  // doesn't deep-read every session file on open. `all:true` returns everything
  // (the "load more" path). `total` lets the UI show how many are hidden.
  ipcMain.handle("ccRoom:listSessions", async (_e, cwd: string, all?: boolean) => {
    cwd = await requireRendererProjectPath(cwd);
    const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
    return listRelatedClaudeSessions(cwd, opts, {}, Boolean(all));
  });
  ipcMain.handle("ccRoom:listCodexSessions", async (_e, cwd: string, all?: boolean) => {
    cwd = await requireRendererProjectPath(cwd);
    const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
    return listRelatedCodexSessions(cwd, opts);
  });
  registerLinkedSessionObservationIpc({
    ipcMain,
    windows: mainWindows,
    roomManager,
    listBackgroundWork: createTaskInboxBackgroundHost({ worker: () => deps.bridge() }).list,
    requirePath: requireRendererLinkedSessionPath,
    subscriptions: transcriptSubscriptions,
    roomMatchesTranscript: (...args) => mobileOrchestrator.roomMatchesTranscript(...args),
    pendingApprovals: (roomId) => approvalBridge.pendingRequests(roomId),
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
  ipcMain.handle(
    "ccRoom:readHistory",
    async (_e, cwd: string, sessionId: string, limit: number) => {
      cwd = await requireRendererProjectPath(cwd);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error("invalid limit");
      return readRecentHistory(cwd, sessionId, limit);
    },
  );
  ipcMain.handle(
    "ccRoom:readCodexHistory",
    async (_e, cwd: string, threadId: string, limit: number) => {
      cwd = await requireRendererProjectPath(cwd);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error("invalid limit");
      return readCodexRecentHistory(cwd, threadId, limit);
    },
  );

  // Remaining CC/Codex subscription quota. Reads tokens from Keychain / ~/.codex
  // then hits each vendor's usage source. `provider` restricts the lookup
  // ("codex" is free; "claude" sends a ~1-token probe). Never throws — a failed
  // lookup lands in the per-provider `error` field.
  ipcMain.handle(
    "quota:get",
    async (_e, provider?: "claude" | "codex" | "both"): Promise<QuotaResult> => {
      const creds = await resolveQuotaCredentials();
      const providers: ("claude" | "codex")[] =
        provider === "claude" ? ["claude"] : provider === "codex" ? ["codex"] : ["claude", "codex"];
      return checkQuota({ creds, providers });
    },
  );
}
