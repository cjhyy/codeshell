import { createHash } from "node:crypto";
import { submitRoomInputOnce } from "./room-input-receipts.js";
import { markAttachmentsSent } from "@cjhyy/code-shell-server/storage";
import {
  materializeMobileAttachments,
  type MobileServerEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import { dlog } from "../desktop-logger.js";
import type { AuthenticatedMobileClientEvent, OrchestratorCtx } from "./handle-client-event.js";

/**
 * Handle a room.* mobile event. Rooms are resident stream-json Claude Code
 * sessions; they do not go through the chat worker bridge. A room's
 * permission mode is decided by the Host RoomModeAuthority: an explicit
 * bypassPermissions outside the Host-managed allowlist is refused with a
 * reason (it needs the high-risk approval of the CLI session open flow),
 * never silently turned into "default". Starting a stored bypass room also
 * needs a live Host grant (RoomManager authorizeStart).
 */
export async function handleRoomEvent(
  ctx: OrchestratorCtx,
  event: AuthenticatedMobileClientEvent,
): Promise<void> {
  const reply = (serverEvent: MobileServerEvent): void => {
    if (event.viewerId) ctx.remote.sendToViewer(event.viewerId, serverEvent);
    else if (event.deviceId) ctx.remote.sendToDevice(event.deviceId, serverEvent);
    else ctx.remote.broadcast(serverEvent);
  };
  try {
    if (event.type === "room.list") {
      ctx.remote.broadcast({
        type: "room.list.ok",
        rooms: ctx.roomManager.listRooms().map((room) => ctx.roomToPublic(room)),
      });
      return;
    }
    if (event.type === "room.projects") {
      await ctx.sendProjectList(event.deviceId);
      return;
    }
    if (event.type === "room.create") {
      const kind = event.kind ?? "claude-code";
      if (!ctx.roomModes) {
        if (event.permissionMode === "bypassPermissions")
          throw new Error("Host 权限模式授权不可用，不能创建全放行房间。");
      }
      const decided = ctx.roomModes
        ? await ctx.roomModes.resolveCreateMode(kind, event.cwd, event.permissionMode)
        : { mode: event.permissionMode ?? "default", trustedBypass: false };
      const room = ctx.roomManager.createRoom({
        name: event.name,
        cwd: event.cwd,
        kind,
        permissionMode: decided.mode,
      });
      if (decided.trustedBypass) ctx.roomModes?.grantTrusted(room.id, room.cwd, room.kind);
      const opened = ctx.roomManager.open(room.id);
      ctx.remote.broadcast({
        type: "room.list.ok",
        rooms: ctx.roomManager.listRooms().map((r) => ctx.roomToPublic(r)),
      });
      ctx.remote.broadcast({
        type: "room.opened",
        roomId: room.id,
        status: opened.status,
      });
      return;
    }
    if (event.type === "room.open") {
      const res = ctx.roomManager.open(event.roomId);
      ctx.remote.broadcast({
        type: "room.opened",
        roomId: event.roomId,
        status: res.status,
      });
      return;
    }
    if (event.type === "room.close") {
      ctx.roomManager.close(event.roomId);
      ctx.remote.broadcast({ type: "room.closed", roomId: event.roomId });
      return;
    }
    if (event.type === "room.history" && event.page) {
      const { messages, ...page } = ctx.roomManager.getHistoryPage(event.roomId, {
        sinceSeq: event.sinceSeq,
        cursor: event.cursor,
        limit: event.limit,
      });
      reply({
        type: "room.history.ok",
        roomId: event.roomId,
        messages,
        latestSeq: page.throughSeq,
        page,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type === "room.history") {
      const messages = ctx.roomManager.getMessages(event.roomId, event.sinceSeq ?? 0);
      const latestSeq = messages.length
        ? messages[messages.length - 1]!.seq
        : (event.sinceSeq ?? 0);
      ctx.remote.broadcast({
        type: "room.history.ok",
        roomId: event.roomId,
        messages,
        latestSeq,
      });
      return;
    }
    if (event.type === "room.send") {
      const clientMessageId =
        event.clientMessageId?.trim() ||
        `room:${event.roomId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
      if (clientMessageId.length > 200) {
        reply({
          type: "room.error",
          roomId: event.roomId,
          clientMessageId,
          message: "clientMessageId is too long",
        });
        return;
      }
      const room = ctx.roomManager.getRoom(event.roomId);
      if (!room) {
        reply({
          type: "room.error",
          roomId: event.roomId,
          clientMessageId,
          message: "房间不存在",
        });
        return;
      }
      const text = typeof event.text === "string" ? event.text.trim() : "";
      const receipt = {
        clientMessageId,
        clientDeviceId: event.deviceId ?? "legacy",
        clientIntentHash: createHash("sha256")
          .update(JSON.stringify([text, event.attachments ?? []]))
          .digest("hex"),
      };
      const accepted = await submitRoomInputOnce(ctx.roomManager, room.id, receipt, async () => {
        const materialized = await materializeMobileAttachments({
          deviceId: event.deviceId ?? "",
          cwd: room.cwd,
          sessionId: room.id,
          attachments: event.attachments,
          uploads: ctx.uploads,
        });
        let ok: boolean;
        try {
          ok = ctx.roomManager.send(event.roomId, text, materialized.metas, receipt);
        } catch (error) {
          await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
          throw error;
        }
        if (!ok) {
          await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
          return false;
        }
        await markAttachmentsSent(room.cwd, room.id, materialized.metas).catch((error) =>
          dlog("main", "mobile.room_attachment.mark_sent_failed", {
            error: String(error),
            roomId: room.id,
          }),
        );
        await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "finalize");
        return true;
      });
      if (!accepted) {
        reply({
          type: "room.error",
          roomId: event.roomId,
          clientMessageId,
          message: "房间未就绪或已关闭",
        });
        return;
      }
      reply({ type: "room.accepted", roomId: event.roomId, clientMessageId });
      return;
    }
  } catch (err) {
    reply({
      type: "room.error",
      ...("roomId" in event ? { roomId: event.roomId } : {}),
      ...(event.type === "room.history" && event.requestId ? { requestId: event.requestId } : {}),
      message: err instanceof Error ? err.message : String(err),
      ...("clientMessageId" in event && typeof event.clientMessageId === "string"
        ? { clientMessageId: event.clientMessageId }
        : {}),
    });
  }
}
