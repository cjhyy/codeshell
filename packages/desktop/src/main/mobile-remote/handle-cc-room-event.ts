import {
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  countRelatedSessions,
  discoverRelatedSessions,
  listRelatedCodexSessions,
  probeClaudeCli,
  probeCodexCli,
  readCodexRecentHistory,
  readRecentHistory,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  mobileTranscriptSubscriberId,
  type MobileServerEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { AuthenticatedMobileClientEvent, OrchestratorCtx } from "./handle-client-event.js";
import { mobileRoomModeRequesterKey } from "../cc-room/room-mode-authority.js";
import { takeOverLinkedSessionAtHost } from "../cc-room/linked-session-ipc.js";

/**
 * CC Room (external `claude` CLI sessions) for mobile — mirrors the desktop
 * ccRoom:* IPC handlers, reusing the SAME core discovery + roomManager
 * backend. Discovery replies (probe/listSessions/readHistory) go per-device;
 * open and approval-response feed the shared roomManager / approvalBridge
 * (the room is dual-ended, like desktop). listSessions echoes the cwd so a
 * phone that has since switched projects can discard a stale reply.
 */
export async function handleCcRoomEvent(
  ctx: OrchestratorCtx,
  event: AuthenticatedMobileClientEvent,
): Promise<void> {
  const deviceId = event.deviceId;
  const reply = (e: MobileServerEvent): void => {
    if (event.viewerId) ctx.remote.sendToViewer(event.viewerId, e);
    else if (deviceId) ctx.remote.sendToDevice(deviceId, e);
    else ctx.remote.broadcast(e);
  };
  // Approval prompts are pushed once. A viewer that was viewing another
  // conversation or offline at that moment rebuilds the cards it missed
  // whenever it (re)opens the room; the CLI is still waiting for them.
  const replayPendingApprovals = (roomId: string): void => {
    for (const req of ctx.approvalBridge.pendingRequests(roomId)) {
      reply({ type: "ccRoom.approvalRequest", roomId, req });
    }
  };
  try {
    if (event.type === "ccRoom.probe") {
      const kind = event.kind ?? "claude-code";
      const a = await (kind === "codex" ? probeCodexCli : probeClaudeCli)(Boolean(event.force));
      reply({
        type: "ccRoom.probe.ok",
        available: a.available,
        command: a.command,
        version: a.version,
        reason: a.reason,
        kind,
      });
      return;
    }
    if (event.type === "ccRoom.listSessions") {
      const kind = event.kind ?? "claude-code";
      // Match Desktop's bounded default and explicit older-history action.
      const opts = event.all
        ? {}
        : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
      const result =
        kind === "codex"
          ? await listRelatedCodexSessions(event.cwd, opts)
          : (() => {
              const sessions = discoverRelatedSessions("claude", event.cwd, opts);
              return {
                sessions,
                total: event.all ? sessions.length : countRelatedSessions("claude", event.cwd),
              };
            })();
      reply({
        type: "ccRoom.listSessions.ok",
        cwd: event.cwd,
        ...result,
        kind,
        all: Boolean(event.all),
      });
      return;
    }
    if (event.type === "ccRoom.openSession") {
      const requestId = event.requestId;
      try {
        if (!ctx.roomModes) throw new Error("Host 权限模式授权不可用，无法打开 CLI 会话。");
        const viewerId = event.viewerId;
        const result = await ctx.roomModes.openSession({
          sessionId: event.sessionId,
          ...(event.roomId ? { roomId: event.roomId } : {}),
          ...(event.modelKey !== undefined ? { modelKey: event.modelKey } : {}),
          cwd: event.cwd,
          kind: event.kind ?? "claude-code",
          mode: event.mode,
          requester: {
            key: mobileRoomModeRequesterKey(viewerId ?? `device:${deviceId ?? ""}`),
            channel: "mobile",
            ...(requestId ? { openRequestId: requestId } : {}),
            assertCurrent: () => {
              if (!viewerId || !deviceId || !ctx.remote.hasAuthenticatedViewer(viewerId, deviceId))
                throw new Error("requester disconnected");
            },
          },
        });
        reply({
          type: "ccRoom.opened",
          roomId: result.roomId,
          sessionId: event.sessionId,
          status: result.status,
          // The mode the process actually runs in, never just the request.
          permissionMode: result.mode,
          modelKey: result.modelKey ?? null,
          changed: result.changed,
          ...(requestId ? { requestId } : {}),
        });
        // Other phones and Desktop windows must not keep showing the old mode.
        if (result.changed) ctx.broadcastRoomState?.(result.roomId);
        replayPendingApprovals(result.roomId);
      } catch (error) {
        reply({
          type: "room.error",
          message: error instanceof Error ? error.message : String(error),
          ...(requestId ? { requestId } : {}),
        });
      }
      return;
    }
    if (event.type === "ccRoom.takeOver") {
      // Desktop's take-over, through the same Host function and refusals.
      try {
        const requirePath = ctx.requireLinkedSessionPath;
        if (!requirePath) throw new Error("此电脑不支持从远程接管 CLI 会话，请更新桌面端。");
        const result = await takeOverLinkedSessionAtHost(
          { roomManager: ctx.roomManager, requirePath, broadcastRoomState: ctx.broadcastRoomState },
          event.roomId,
          event.sessionId,
          event.cwd,
          event.kind,
        );
        reply({
          type: "ccRoom.opened",
          roomId: result.roomId,
          sessionId: event.sessionId,
          status: result.status,
          permissionMode: result.mode,
          modelKey: ctx.roomManager.getRoom(result.roomId)?.modelKey ?? null,
          changed: true,
          requestId: event.requestId,
        });
        replayPendingApprovals(result.roomId);
      } catch (error) {
        reply({
          type: "room.error",
          roomId: event.roomId,
          requestId: event.requestId,
          message: `无法接管：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    if (event.type === "ccRoom.subscribeTranscript") {
      const kind = event.kind ?? "claude-code";
      if (!ctx.roomMatchesTranscript(event.roomId, event.cwd, event.sessionId, kind)) {
        throw new Error("cc-room transcript subscription does not match the opened room");
      }
      const snapshot = ctx.transcriptSubscriptions.subscribe({
        subscriberId: mobileTranscriptSubscriberId(event.viewerId ?? ""),
        roomId: event.roomId,
        cwd: event.cwd,
        sessionId: event.sessionId,
        kind,
        limit: event.limit,
      });
      reply({
        type: "ccRoom.transcriptSubscribed",
        roomId: event.roomId,
        sessionId: event.sessionId,
        ...snapshot,
      });
      replayPendingApprovals(event.roomId);
      return;
    }
    if (event.type === "ccRoom.unsubscribeTranscript") {
      ctx.transcriptSubscriptions.unsubscribe(
        mobileTranscriptSubscriberId(event.viewerId ?? ""),
        event.roomId,
      );
      return;
    }
    if (event.type === "ccRoom.readHistory") {
      const h =
        event.kind === "codex"
          ? readCodexRecentHistory(event.cwd, event.sessionId, event.limit, undefined, event.before)
          : readRecentHistory(event.cwd, event.sessionId, event.limit, undefined, event.before);
      reply({
        type: "ccRoom.readHistory.ok",
        sessionId: event.sessionId,
        messages: h.messages,
        hasMore: h.hasMore,
        totalCount: h.totalCount,
        startIndex: h.startIndex,
        ...(event.before !== undefined ? { before: event.before } : {}),
      });
      return;
    }
    if (event.type === "ccRoom.respondApproval") {
      ctx.approvalBridge.respond(event.roomId, event.requestId, event.decision);
      return;
    }
  } catch (err) {
    // Carry what identifies the failed operation so the viewer can attach the
    // failure to its card (e.g. re-enable an approval it already hid).
    reply({
      type: "room.error",
      message: err instanceof Error ? err.message : String(err),
      ...("roomId" in event && event.roomId ? { roomId: event.roomId } : {}),
      ...(event.type === "ccRoom.respondApproval" ? { approvalRequestId: event.requestId } : {}),
    });
  }
}
