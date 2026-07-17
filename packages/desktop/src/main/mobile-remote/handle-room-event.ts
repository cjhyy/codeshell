import { resolveExternalAgentConfig } from "@cjhyy/code-shell-capability-coding/orchestration";
import { markAttachmentsSent } from "@cjhyy/code-shell-server/storage";
import {
  materializeMobileAttachments,
  type MobileServerEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import { dlog } from "../desktop-logger.js";
import { readSettings } from "../settings-service.js";
import type { AuthenticatedMobileClientEvent, OrchestratorCtx } from "./handle-client-event.js";

/**
 * Decide a room's permission mode. A room in a TRUSTED workspace (per
 * externalAgents.claudeCode.trustedWorkspaces, the same allowlist that governs
 * /cc dangerous mode) gets bypassPermissions so the resident CC can actually
 * do work without being blocked by its own default gate. Anywhere else stays
 * "default" (CC auto-denies risky ops). An explicit mode from the phone wins,
 * EXCEPT a non-trusted cwd cannot silently get bypassPermissions — it is
 * downgraded to "default" (the high-risk gate). cwd normalized to ignore
 * trailing slashes.
 */
export async function resolveRoomPermissionMode(
  cwd: string,
  explicit: "default" | "acceptEdits" | "bypassPermissions" | undefined,
): Promise<"default" | "acceptEdits" | "bypassPermissions"> {
  const userSettings = ((await readSettings("user", cwd).catch(() => null)) ?? {}) as {
    externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
  };
  const projectSettings = ((await readSettings("project", cwd).catch(() => null)) ?? {}) as {
    externalAgents?: Parameters<typeof resolveExternalAgentConfig>[0];
  };
  const userAgents = userSettings.externalAgents ?? {};
  const projectAgents = projectSettings.externalAgents ?? {};
  const mergedAgents = {
    ...userAgents,
    ...projectAgents,
    claudeCode: {
      ...userAgents.claudeCode,
      ...projectAgents.claudeCode,
    },
  };
  const cfg = resolveExternalAgentConfig(mergedAgents).claudeCode;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const trusted = cfg.trustedWorkspaces.some((p) => norm(p) === norm(cwd));
  if (explicit === "bypassPermissions") {
    return trusted ? "bypassPermissions" : "default"; // non-trusted can't silently bypass
  }
  if (explicit) return explicit;
  return trusted ? "bypassPermissions" : "default";
}

/**
 * Handle a room.* mobile event. Rooms are resident stream-json Claude Code
 * sessions; they do not go through the chat worker bridge. permissionMode
 * for a non-trusted cwd that requests bypassPermissions is downgraded to
 * "default" here (the high-risk gate is surfaced by the UI / future
 * approval step).
 */
export async function handleRoomEvent(
  ctx: OrchestratorCtx,
  event: AuthenticatedMobileClientEvent,
): Promise<void> {
  const reply = (serverEvent: MobileServerEvent): void => {
    if (event.deviceId) ctx.remote.sendToDevice(event.deviceId, serverEvent);
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
      const permissionMode = await resolveRoomPermissionMode(event.cwd, event.permissionMode);
      const room = ctx.roomManager.createRoom({
        name: event.name,
        cwd: event.cwd,
        kind: event.kind,
        permissionMode,
      });
      const opened = ctx.roomManager.open(room.id);
      ctx.remote.broadcast({
        type: "room.list.ok",
        rooms: ctx.roomManager.listRooms().map((r) => ctx.roomToPublic(r)),
      });
      ctx.remote.broadcast({ type: "room.opened", roomId: room.id, status: opened.status });
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
      const materialized = await materializeMobileAttachments({
        deviceId: event.deviceId ?? "",
        cwd: room.cwd,
        sessionId: room.id,
        attachments: event.attachments,
        uploads: ctx.uploads,
      });
      let ok: boolean;
      try {
        ok = ctx.roomManager.send(event.roomId, text, materialized.metas);
      } catch (error) {
        await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
        throw error;
      }
      if (!ok) {
        await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
        reply({
          type: "room.error",
          roomId: event.roomId,
          clientMessageId,
          message: "房间未就绪或已关闭",
        });
        return;
      }
      await markAttachmentsSent(room.cwd, room.id, materialized.metas).catch((error) =>
        dlog("main", "mobile.room_attachment.mark_sent_failed", {
          error: String(error),
          roomId: room.id,
        }),
      );
      await ctx.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "finalize");
      reply({ type: "room.accepted", roomId: event.roomId, clientMessageId });
      return;
    }
  } catch (err) {
    reply({
      type: "room.error",
      message: err instanceof Error ? err.message : String(err),
      ...("clientMessageId" in event && typeof event.clientMessageId === "string"
        ? { clientMessageId: event.clientMessageId }
        : {}),
    });
  }
}
