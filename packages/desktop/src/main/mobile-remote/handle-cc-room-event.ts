import {
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  discoverRelatedSessions,
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
import { resolveRoomPermissionMode } from "./handle-room-event.js";

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
    if (deviceId) ctx.remote.sendToDevice(deviceId, e);
    else ctx.remote.broadcast(e);
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
      // Bound the mobile list too (recent 2 weeks AND ≤20) — phones especially
      // shouldn't pull + deep-read an entire project's session history.
      const opts = { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
      const sessions = discoverRelatedSessions(
        kind === "codex" ? "codex" : "claude",
        event.cwd,
        opts,
      );
      reply({ type: "ccRoom.listSessions.ok", cwd: event.cwd, sessions, kind });
      return;
    }
    if (event.type === "ccRoom.openSession") {
      const mode = await resolveRoomPermissionMode(event.cwd, event.mode);
      const { roomId, status } = ctx.roomManager.openForSession(
        event.sessionId,
        event.cwd,
        mode,
        event.kind ?? "claude-code",
      );
      reply({ type: "ccRoom.opened", roomId, sessionId: event.sessionId, status });
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
          ? readCodexRecentHistory(event.cwd, event.sessionId, event.limit)
          : readRecentHistory(event.cwd, event.sessionId, event.limit);
      reply({
        type: "ccRoom.readHistory.ok",
        sessionId: event.sessionId,
        messages: h.messages,
        hasMore: h.hasMore,
        totalCount: h.totalCount,
      });
      return;
    }
    if (event.type === "ccRoom.respondApproval") {
      ctx.approvalBridge.respond(event.roomId, event.requestId, event.decision);
      return;
    }
  } catch (err) {
    reply({ type: "room.error", message: err instanceof Error ? err.message : String(err) });
  }
}
