import {
  buildSessionHistory,
  dispatchMobileChatTurn,
  listDiskSessions,
  type ClaimedMobileUpload,
  type MobileClientEvent,
  type MobileServerEvent,
  type MobileUploadService,
  type PermissionMode,
  type RemoteHostManager,
  type RoomManager,
  type RoomMeta,
  type RoomPublic,
} from "@cjhyy/code-shell-server";
import type { AgentBridge } from "../agent-bridge.js";
import type { ApprovalBridge } from "../cc-room/approval-bridge.js";
import type { TranscriptSubscriptionManager } from "../cc-room/transcript-subscriptions.js";
import { getSessionWorkspaceForUi } from "../session-workspace-service.js";
import { getSessionTranscript } from "../transcript-reader.js";
import { handleCcRoomEvent } from "./handle-cc-room-event.js";
import { handleRoomEvent } from "./handle-room-event.js";

/**
 * The remote host tags authenticated events with both the device id and a
 * per-socket viewer id. Device state/replies remain shared per phone, while
 * transcript ownership follows the exact tab that subscribed.
 */
export type AuthenticatedMobileClientEvent = MobileClientEvent & {
  deviceId?: string;
  viewerId?: string;
};

/**
 * Per-device mobile state. Each connected phone/tablet drives its OWN session
 * selection, so two devices never clobber each other (a shared global made
 * device B's "select session 2" overwrite device A). Keyed by trusted-device
 * id. The agent OUTPUT stream is still broadcast to all devices (each
 * front-end filters to its bound session — so switching to another session and
 * pulling its history shows the latest), but per-device REPLIES
 * (chat.accepted / permission.mode / session.*) go only to that device.
 */
export interface MobileDeviceState {
  /** Lazily-minted fallback session id for this device's fresh chats. */
  sessionId?: string;
  /** The session this device explicitly selected (overrides everything). */
  selectedSessionId?: string;
  /** The cwd bound to the selected or freshly-created mobile session. */
  selectedCwd?: string | null;
  /** Preset chosen before this device has a concrete session; promoted later. */
  permissionMode?: PermissionMode;
}

/** Narrow facade over the orchestrator state used by the three domain handlers. */
export interface OrchestratorCtx {
  remote: RemoteHostManager;
  uploads: MobileUploadService;
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "respond">;
  transcriptSubscriptions: TranscriptSubscriptionManager;
  getBridge: () => AgentBridge | null;
  mobileSessionCwds: Map<string, string | null>;
  mobilePermissionModes: Map<string, PermissionMode>;
  deviceState: (deviceId: string) => MobileDeviceState;
  ensureMobileSessionId: (state: MobileDeviceState) => string;
  lookupDiskSessionCwd: (sessionId: string) => Promise<string | null | undefined>;
  effectiveMobileRunCwd: (state: MobileDeviceState, contextCwd?: string) => string;
  sendMobilePermissionMode: (deviceId: string | undefined, sessionId: string) => void;
  sendSelectedMobilePermissionModes: () => void;
  replayPendingMobileApprovals: (sessionId: string, deviceId?: string) => void;
  broadcastDesktopPermissionMode: (params: { sessionId: string; mode: PermissionMode }) => void;
  broadcastMobileSession: (meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    clientMessageId?: string;
  }) => void;
  broadcastApprovalResolved: (params: {
    requestId: string;
    sessionId?: string;
    approved?: boolean;
  }) => void;
  roomToPublic: (room: RoomMeta) => RoomPublic;
  roomMatchesTranscript: (
    roomId: string,
    cwd: string,
    sessionId: string,
    kind: "claude-code" | "codex",
  ) => boolean;
  sendProjectList: (deviceId?: string) => Promise<void>;
  settleMobileUploadClaims: (
    deviceId: string,
    claims: ClaimedMobileUpload[],
    action: "release" | "finalize",
  ) => Promise<void>;
}

/**
 * Inject a JSON-RPC request into the worker and resolve with its ACTUAL
 * response (result on success, or failure on a JSON-RPC error / timeout). The
 * worker's reply flows back through subscribeOutbound (the same lines mirrored
 * to mobile), so we correlate by request id rather than fabricating success — a
 * model.set for an invalid model or a rejected goal.extend must NOT be reported
 * to the phone as ok.
 */
// Monotonic suffix so two requests for the same method in the same millisecond
// get distinct ids (Date.now() alone collides under concurrency → reply串台).
let mobileRequestSeq = 0;
export function injectAndAwaitResult(
  b: AgentBridge,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }> {
  const id = `mobile-${method.replace(/\W+/g, "-")}-${Date.now()}-${mobileRequestSeq++}`;
  return new Promise((resolveResult) => {
    let settled = false;
    const done = (
      v: { ok: true; result: unknown } | { ok: false; message: string; code?: number },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolveResult(v);
    };
    const unsub = b.subscribeOutbound((line) => {
      try {
        const m = JSON.parse(line) as {
          id?: string;
          result?: unknown;
          error?: { message?: string; code?: number };
        };
        if (m.id !== id) return;
        if (m.error)
          done({
            ok: false,
            message: m.error.message ?? "worker rejected the request",
            code: m.error.code,
          });
        else done({ ok: true, result: m.result });
      } catch {
        /* not JSON / not ours */
      }
    });
    // Fallback: if the worker never answers (dead/slow), report failure rather
    // than hanging — the phone keeps showing its prior state.
    const timer = setTimeout(() => done({ ok: false, message: "worker did not respond" }), 5000);
    b.injectWorkerMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

/**
 * Route an authenticated mobile client event into the SAME run/permission
 * path the renderer uses, via AgentBridge.injectWorkerMessage.
 */
export async function handleClientEvent(
  ctx: OrchestratorCtx,
  event: AuthenticatedMobileClientEvent,
): Promise<void> {
  if (event.type === "attachment.upload.begin") {
    const deviceId = event.deviceId;
    if (!deviceId) return;
    try {
      const ticket = ctx.uploads.begin(deviceId, {
        clientId: event.clientId,
        name: event.name,
        mime: event.mime,
        size: event.size,
      });
      ctx.remote.sendToDevice(deviceId, { type: "attachment.upload.ready", ...ticket });
    } catch (error) {
      ctx.remote.sendToDevice(deviceId, {
        type: "attachment.upload.failed",
        clientId: event.clientId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  // ── CC Room (external claude CLI sessions) — checked first so "ccRoom.*"
  // never gets misrouted by the "room." prefix check below ───────────────
  if (event.type.startsWith("ccRoom.")) {
    await handleCcRoomEvent(ctx, event);
    return;
  }
  // ── Rooms (independent of the chat worker bridge) ─────────────────────
  if (event.type.startsWith("room.")) {
    await handleRoomEvent(ctx, event);
    return;
  }
  const bridge = ctx.getBridge();
  if (!bridge) return;
  const runContext = bridge.getLastRunContext();
  // Per-device state: the remote host tags every authenticated event with the
  // device id (see onClientEvent wiring). Replies that are device-specific go
  // back to ONLY that device via sendToDevice; the agent output stream is
  // still broadcast (each front-end filters to its bound session).
  const deviceId = event.deviceId;
  const st = deviceId ? ctx.deviceState(deviceId) : {};
  const reply = (e: MobileServerEvent): void => {
    if (deviceId) ctx.remote.sendToDevice(deviceId, e);
    else ctx.remote.broadcast(e);
  };
  // session selection priority: explicit per-event → this device's selection →
  // desktop's current run → a stable minted per-device session.
  const resolveSessionId = (explicit?: string): string =>
    explicit ?? st.selectedSessionId ?? runContext.sessionId ?? ctx.ensureMobileSessionId(st);
  if (event.type === "session.select") {
    st.selectedSessionId = event.sessionId;
    const cwd = await ctx.lookupDiskSessionCwd(event.sessionId);
    if (cwd !== undefined) st.selectedCwd = cwd;
    if (deviceId) ctx.sendMobilePermissionMode(deviceId, event.sessionId);
    else {
      reply({
        type: "permission.mode",
        sessionId: event.sessionId,
        mode: ctx.mobilePermissionModes.get(event.sessionId) ?? "default",
      });
    }
    ctx.replayPendingMobileApprovals(event.sessionId, deviceId);
    return;
  }
  if (event.type === "session.create") {
    // Mint a fresh session for THIS device and make it its active selection.
    st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    st.selectedSessionId = st.sessionId;
    if ("cwd" in event) {
      st.selectedCwd = event.cwd ?? null;
    } else {
      st.selectedCwd = runContext.cwd ?? process.cwd();
    }
    ctx.mobileSessionCwds.set(st.sessionId, st.selectedCwd);
    if (st.permissionMode) ctx.mobilePermissionModes.set(st.sessionId, st.permissionMode);
    reply({ type: "chat.accepted", sessionId: st.sessionId, cwd: st.selectedCwd });
    if (deviceId) ctx.sendMobilePermissionMode(deviceId, st.sessionId);
    else {
      reply({
        type: "permission.mode",
        sessionId: st.sessionId,
        mode: ctx.mobilePermissionModes.get(st.sessionId) ?? "default",
      });
    }
    return;
  }
  if (event.type === "chat.send") {
    const sessionId = resolveSessionId(event.sessionId);
    const fallbackCwd = ctx.effectiveMobileRunCwd(st, runContext.cwd);
    if (st.permissionMode && !ctx.mobilePermissionModes.has(sessionId)) {
      ctx.mobilePermissionModes.set(sessionId, st.permissionMode);
    }
    const permissionMode = ctx.mobilePermissionModes.get(sessionId);
    const text = typeof event.text === "string" ? event.text.trim() : "";
    const runId = `mobile-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const dispatched = await dispatchMobileChatTurn({
      deviceId: deviceId ?? "",
      sessionId,
      fallbackCwd,
      text,
      attachments: event.attachments,
      clientMessageId: event.clientMessageId,
      permissionMode,
      runId,
      bridge,
      uploads: ctx.uploads,
      resolveWorkspace: (targetSessionId, fallback) =>
        getSessionWorkspaceForUi(targetSessionId, fallback)
          .then((workspace) => workspace.root)
          .catch(() => fallback),
    });
    if (!dispatched.ok) {
      reply({
        type: "error",
        message: dispatched.message,
        ...(event.clientMessageId ? { clientMessageId: event.clientMessageId } : {}),
      });
      return;
    }
    ctx.mobileSessionCwds.set(sessionId, dispatched.cwd);
    const title = text || `图片 ${dispatched.metas.length} 张`;
    ctx.broadcastMobileSession({
      sessionId,
      cwd: dispatched.cwd,
      title,
      prompt: text,
      clientMessageId: dispatched.clientMessageId,
    });
    // Tell THIS device which session its turn landed in.
    reply({
      type: "chat.accepted",
      sessionId,
      cwd: dispatched.cwd,
      clientMessageId: dispatched.clientMessageId,
      attachments: dispatched.summaries,
    });
    return;
  }
  if (event.type === "approval.respond") {
    // Build the same ApprovalResult branch the renderer's preload assembles:
    // approve carries optional answer (AskUser) + remembered scope/pathScope;
    // reject carries an optional reason. Decisions still go through the core
    // permission engine — the remote host never bypasses it (design §6).
    let decision: Record<string, unknown>;
    if (event.decision === "approve") {
      const branch: Record<string, unknown> = { approved: true };
      if (event.answer !== undefined) branch.answer = event.answer;
      if (event.scope && event.scope !== "once") {
        branch.always = true;
        branch.scope = event.scope;
        if (event.pathScope && event.pathScope !== "tool") branch.pathScope = event.pathScope;
      }
      decision = branch;
    } else {
      decision = { approved: false, reason: event.reason };
    }
    const sessionId = resolveSessionId(event.sessionId);
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-approve-${Date.now()}`,
        method: "agent/approve",
        params: { sessionId, requestId: event.approvalId, decision },
      }),
    );
    ctx.broadcastApprovalResolved({
      requestId: event.approvalId,
      sessionId,
      approved: event.decision === "approve",
    });
    return;
  }
  if (event.type === "run.stop") {
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-cancel-${Date.now()}`,
        method: "agent/cancel",
        params: { sessionId: resolveSessionId(event.sessionId) },
      }),
    );
    return;
  }
  if (event.type === "session.list") {
    // Every desktop session the sidebar would show (top-level, existing cwd).
    const { sessions } = await listDiskSessions({ limit: 100 });
    for (const s of sessions) ctx.mobileSessionCwds.set(s.id, s.cwd || null);
    const activeSessionId = st.selectedSessionId ?? runContext.sessionId;
    reply({
      type: "session.list.ok",
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        origin: s.origin,
      })),
      activeSessionId,
    });
    if (activeSessionId) {
      if (deviceId) ctx.sendMobilePermissionMode(deviceId, activeSessionId);
      else {
        reply({
          type: "permission.mode",
          sessionId: activeSessionId,
          mode: ctx.mobilePermissionModes.get(activeSessionId) ?? "default",
        });
      }
    }
    return;
  }
  if (event.type === "session.history") {
    try {
      const events = await buildSessionHistory(event.sessionId, getSessionTranscript);
      reply({ type: "session.history.ok", sessionId: event.sessionId, events });
    } catch (err) {
      reply({
        type: "error",
        message: `读取会话历史失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }
  if (event.type === "session.sync") {
    const snapshot = bridge.getSnapshot(
      event.sessionId,
      typeof event.sinceSeq === "number" ? event.sinceSeq : 0,
    );
    reply({
      type: "session.snapshot",
      sessionId: event.sessionId,
      entries: snapshot.events,
      nextSeq: snapshot.nextSeq,
    });
    ctx.replayPendingMobileApprovals(event.sessionId, deviceId);
    return;
  }
  if (event.type === "permission.setMode") {
    const sessionId = event.sessionId ?? st.selectedSessionId;
    if (sessionId) {
      ctx.mobilePermissionModes.set(sessionId, event.mode);
      ctx.sendSelectedMobilePermissionModes();
      ctx.broadcastDesktopPermissionMode({ sessionId, mode: event.mode });
    } else {
      // No session is bound yet; keep this as the preset for the next mobile
      // session this device creates, then promote it into the session map.
      st.permissionMode = event.mode;
      reply({ type: "permission.mode", mode: event.mode });
    }
    return;
  }
  if (event.type === "model.set") {
    // Only confirm the model AFTER the worker actually applied it; an invalid
    // model name must not be shown as the current model. Model is
    // engine-global, so a successful change broadcasts to all devices.
    const res = await injectAndAwaitResult(bridge, "agent/configure", { model: event.model });
    if (res.ok) {
      ctx.remote.broadcast({ type: "model.current", model: event.model });
    } else {
      reply({ type: "error", message: `切换模型失败:${res.message}` });
    }
    return;
  }
  if (event.type === "goal.extend") {
    const res = await injectAndAwaitResult(bridge, "agent/goalExtend", {
      sessionId: event.sessionId,
      addTurns: event.addTurns,
      addTokenBudget: event.addTokenBudget,
      addTimeBudgetMs: event.addTimeBudgetMs,
      addStopBlocks: event.addStopBlocks,
    });
    // Report the REAL outcome (ok:false carries the worker's reason).
    reply({
      type: "goal.extended",
      sessionId: event.sessionId,
      ok: res.ok,
      message: res.ok ? undefined : res.message,
    });
    return;
  }
  if (event.type === "goal.clear") {
    const res = await injectAndAwaitResult(bridge, "agent/goalClear", {
      sessionId: event.sessionId,
    });
    // The worker's result carries { ok, cleared }; surface `cleared` so the
    // phone can tell "there was a goal, now gone" from "nothing to clear".
    const cleared =
      res.ok && typeof (res.result as { cleared?: boolean } | undefined)?.cleared === "boolean"
        ? (res.result as { cleared: boolean }).cleared
        : undefined;
    reply({
      type: "goal.cleared",
      sessionId: event.sessionId,
      ok: res.ok,
      cleared,
      message: res.ok ? undefined : res.message,
    });
    return;
  }
}
