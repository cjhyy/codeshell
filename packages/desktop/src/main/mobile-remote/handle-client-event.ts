import {
  buildSessionHistory,
  dispatchMobileChatTurn,
  type ClaimedMobileUpload,
  type MobileClientEvent,
  type MobileServerEvent,
  type MobileUploadService,
  type PermissionMode,
  type RemoteHostManager,
  type RoomManager,
  type RoomMeta,
  type RoomPublic,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { WorkerFrameMeta } from "@cjhyy/code-shell-server/worker";
import { transcriptUserDisplay } from "@cjhyy/code-shell-web";
import { listDiskSessions } from "@cjhyy/code-shell-server/storage";
import type { AgentBridge } from "../agent-bridge.js";
import type { ApprovalBridge } from "../cc-room/approval-bridge.js";
import type { TranscriptSubscriptionManager } from "../cc-room/transcript-subscriptions.js";
import { getSessionTranscript } from "../transcript-reader.js";
import { handleCcRoomEvent } from "./handle-cc-room-event.js";
import type { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";
import {
  parseExternalRuntimeModelKey,
  type ExternalRuntimeModelEntry,
} from "../../shared/external-runtime-models.js";
import type { mobileNewSessionAuthority } from "./output-recovery-authority.js";
import type { MobileOutputRecovery } from "./output-recovery.js";
import { handleRoomEvent } from "./handle-room-event.js";
import {
  handleOutputHistoryRecoveryCommand,
  type MobileOutputHistoryService,
} from "./output-history-commands.js";
import { captureMobileHistoryWrite, submitMobileHistoryWrite } from "./output-history-chat.js";

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
  /** Stable V2 authority for a freshly-created mobile Session. */
  selectedProjectId?: string | null;
  selectedRootId?: string;
  /** Preset chosen before this device has a concrete session; promoted later. */
  permissionMode?: PermissionMode;
}

/** Narrow facade over the orchestrator state used by the three domain handlers. */
export interface OrchestratorCtx {
  outputRecovery?: MobileOutputRecovery;
  externalCommands?: MobileExternalRuntimeCommands;
  externalRuntimeModels?: () => Promise<ExternalRuntimeModelEntry[]>;
  outputHistoryRecovery?: MobileOutputHistoryService;
  newSessionAuthority?: typeof mobileNewSessionAuthority;
  remote: RemoteHostManager;
  uploads: MobileUploadService;
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "respond" | "pendingRequests">;
  transcriptSubscriptions: TranscriptSubscriptionManager;
  getBridge: () => AgentBridge | null;
  mobileSessionCwds: Map<string, string | null>;
  mobilePermissionModes: Map<string, PermissionMode>;
  deviceState: (deviceId: string) => MobileDeviceState;
  ensureMobileSessionId: (state: MobileDeviceState) => string;
  lookupDiskSessionCwd: (sessionId: string) => Promise<string | null | undefined>;
  effectiveMobileRunCwd: (state: MobileDeviceState) => string;
  resolveMobileProjectRoot: (
    projectId: string,
    rootId?: string,
  ) => { projectId: string; rootId: string; cwd: string };
  validateMobileSessionCwd: (cwd: string) => Promise<boolean>;
  resolveSessionWorkspaceRoot: (sessionId: string, fallbackCwd: string) => Promise<string>;
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
    answer?: string;
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
/**
 * A control op (model.set, goal.extend/clear) is a near-instant worker state
 * change, so a short budget keeps the phone responsive on a bad input.
 *
 * `agent/run` is categorically different: it drives an ENTIRE turn — tool
 * calls, delegation, model inference. Sharing the control-op budget meant a
 * perfectly healthy Mimi turn was declared dead after 5s and surfaced to the
 * user as "Mimi Pet 处理失败：worker did not respond" while the worker was
 * still working. Match agent-bridge's own 120s request budget instead.
 */
const CONTROL_OP_TIMEOUT_MS = 10_000;
const AGENT_RUN_TIMEOUT_MS = 120_000;

export function agentRunTimeoutMs(method: string): number {
  return method === "agent/run" ? AGENT_RUN_TIMEOUT_MS : CONTROL_OP_TIMEOUT_MS;
}

// Monotonic suffix so two requests for the same method in the same millisecond
// get distinct ids (Date.now() alone collides under concurrency → reply串台).
let mobileRequestSeq = 0;
export function injectAndAwaitResult(
  b: AgentBridge,
  method: string,
  params: Record<string, unknown>,
  meta: WorkerFrameMeta,
  timeoutMs: number = agentRunTimeoutMs(method),
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
    const timer = setTimeout(
      () => done({ ok: false, message: "worker did not respond" }),
      timeoutMs,
    );
    try {
      b.injectWorkerMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }), meta);
    } catch (error) {
      done({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function resolveMobileSessionCreateCwd(
  requested: string | null | undefined,
  isAllowed: (cwd: string) => Promise<boolean>,
): Promise<string | null> {
  if (requested == null) return null;
  if (!(await isAllowed(requested))) {
    throw new Error("session cwd is not a mounted project root or no-repo workspace");
  }
  return requested;
}

export interface MobileSessionCreateResolution {
  cwd: string | null;
  projectId?: string | null;
  rootId?: string;
}

export async function resolveMobileSessionCreateTarget(
  event: Extract<MobileClientEvent, { type: "session.create" }>,
  deps: {
    resolveProjectRoot: (
      projectId: string,
      rootId?: string,
    ) => { projectId: string; rootId: string; cwd: string };
    isLegacyCwdAllowed: (cwd: string) => Promise<boolean>;
  },
): Promise<MobileSessionCreateResolution> {
  if (Object.prototype.hasOwnProperty.call(event, "projectId")) {
    if (event.projectId === null) {
      if (event.rootId !== undefined) throw new Error("no-repo session cannot specify rootId");
      return { projectId: null, cwd: null };
    }
    if (!event.projectId) throw new Error("session projectId is required");
    return deps.resolveProjectRoot(event.projectId, event.rootId);
  }
  if (event.rootId !== undefined) throw new Error("session rootId requires projectId");
  const cwd = await resolveMobileSessionCreateCwd(event.cwd, deps.isLegacyCwdAllowed);
  return { cwd };
}

/**
 * Route an authenticated mobile client event into the SAME run/permission
 * path the renderer uses, via AgentBridge.injectWorkerMessage.
 */
export async function handleClientEvent(
  ctx: OrchestratorCtx,
  event: AuthenticatedMobileClientEvent,
): Promise<void> {
  if (
    event.type === "session.outputRecovery.plan" ||
    event.type === "session.outputRecovery.apply"
  ) {
    await handleOutputHistoryRecoveryCommand(
      { remote: ctx.remote, service: ctx.outputHistoryRecovery },
      event,
    );
    return;
  }
  const commandSelection = ctx.externalCommands?.observe(event);
  if (ctx.outputRecovery) {
    const recovery = ctx.outputRecovery.handle(event);
    if (event.type === "session.select" && event.recoveryId) {
      // A later selection/create/room transition can revoke this grant while
      // authority awaits. It must not write the retired device selection back.
      if (!(await recovery)) return;
    } else if (
      event.type === "session.outputJournal" ||
      event.type === "session.legacyBase" ||
      event.type === "session.historyView" ||
      event.type === "session.historyDetail"
    )
      await recovery;
    else void recovery;
  }
  if (
    event.type === "session.outputJournal" ||
    event.type === "session.legacyBase" ||
    event.type === "session.historyView" ||
    event.type === "session.historyDetail" ||
    event.type === "session.recovery.cancel"
  )
    return;
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
  if (event.type === "runtime.models") {
    if (
      !event.viewerId ||
      !event.deviceId ||
      !ctx.remote.hasAuthenticatedViewer(event.viewerId, event.deviceId)
    )
      return;
    try {
      const models = (await ctx.externalRuntimeModels?.()) ?? [];
      if (ctx.remote.hasAuthenticatedViewer(event.viewerId, event.deviceId))
        ctx.remote.sendToViewer(event.viewerId, { type: "runtime.models.ok", models });
    } catch {
      ctx.remote.sendToViewer(event.viewerId, {
        type: "runtime.models.ok",
        models: [],
        message: "暂时无法读取桌面的外部运行时模型。请稍后刷新。",
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
    await commandSelection;
    st.selectedSessionId = event.sessionId;
    st.selectedProjectId = undefined;
    st.selectedRootId = undefined;
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
    await ctx.externalCommands?.replayApprovals(event.viewerId, deviceId, event.sessionId);
    return;
  }
  if (event.type === "session.create") {
    let selection: MobileSessionCreateResolution;
    let nextState: MobileDeviceState;
    try {
      selection = await resolveMobileSessionCreateTarget(event, {
        resolveProjectRoot: ctx.resolveMobileProjectRoot,
        isLegacyCwdAllowed: ctx.validateMobileSessionCwd,
      });
      const sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      nextState = {
        ...st,
        sessionId,
        selectedSessionId: sessionId,
        selectedCwd: selection.cwd,
        selectedProjectId: selection.projectId,
        selectedRootId: selection.rootId,
      };
      // Publish the device selection only after its fresh command authority is valid.
      if (ctx.newSessionAuthority)
        ctx.externalCommands?.created(
          event.viewerId,
          deviceId,
          sessionId,
          ctx.newSessionAuthority(
            ctx.effectiveMobileRunCwd(nextState),
            selection.projectId,
            selection.rootId,
          ),
        );
    } catch (error) {
      reply({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
      });
      return;
    }
    // Mint a fresh session for THIS device and make it its active selection.
    Object.assign(st, nextState);
    const sessionId = nextState.sessionId!;
    ctx.mobileSessionCwds.set(sessionId, st.selectedCwd ?? null);
    if (st.permissionMode) ctx.mobilePermissionModes.set(sessionId, st.permissionMode);
    reply({
      type: "chat.accepted",
      ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
      sessionId,
      cwd: st.selectedCwd,
      ...(selection.projectId !== undefined ? { projectId: selection.projectId } : {}),
      ...(selection.rootId ? { rootId: selection.rootId } : {}),
    });
    if (deviceId) ctx.sendMobilePermissionMode(deviceId, sessionId);
    else {
      reply({
        type: "permission.mode",
        sessionId,
        mode: ctx.mobilePermissionModes.get(sessionId) ?? "default",
      });
    }
    return;
  }
  if (event.type === "chat.send") {
    const sessionId = resolveSessionId(event.sessionId);
    let assertHistoryCurrent: () => void;
    try {
      assertHistoryCurrent = captureMobileHistoryWrite(sessionId);
    } catch {
      reply({
        type: "error",
        message: "会话正在恢复，请完成历史核对后重新发送。",
        ...(event.clientMessageId ? { clientMessageId: event.clientMessageId } : {}),
      });
      return;
    }
    const requestedRuntime = event.modelKey ? parseExternalRuntimeModelKey(event.modelKey) : null;
    if (event.modelKey && !requestedRuntime) {
      reply({
        type: "error",
        message: "请选择有效的外部运行时模型。",
        clientMessageId: event.clientMessageId,
      });
      return;
    }
    const external =
      !!requestedRuntime ||
      (ctx.externalCommands?.isExternal(sessionId, event.viewerId, sessionId === st.sessionId) ??
        false);
    let externalTarget: Awaited<ReturnType<MobileExternalRuntimeCommands["prepare"]>> | undefined;
    if (external) {
      try {
        externalTarget = await ctx.externalCommands!.prepare(event.viewerId, deviceId, sessionId, {
          modelKey: event.modelKey,
          permissionMode: ctx.mobilePermissionModes.get(sessionId) ?? st.permissionMode,
        });
      } catch (error) {
        if (event.viewerId)
          ctx.remote.sendToViewer(event.viewerId, {
            type: "error",
            message:
              error instanceof Error ? error.message : "无法启动桌面的外部运行时。请重新选择会话。",
            ...(event.clientMessageId ? { clientMessageId: event.clientMessageId } : {}),
          });
        return;
      }
    }
    const fallbackCwd = externalTarget?.cwd ?? ctx.effectiveMobileRunCwd(st);
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
      ...(typeof st.selectedProjectId === "string" ? { projectId: st.selectedProjectId } : {}),
      ...(st.selectedRootId ? { rootId: st.selectedRootId } : {}),
      text,
      attachments: event.attachments,
      clientMessageId: event.clientMessageId,
      modelTraceSource: event.modelTraceSource,
      permissionMode,
      runId,
      bridge,
      meta: { origin: "mobile", producer: "mobile-chat" },
      uploads: ctx.uploads,
      resolveWorkspace: externalTarget
        ? async () => externalTarget!.cwd
        : ctx.resolveSessionWorkspaceRoot,
      submit: (request) =>
        submitMobileHistoryWrite(
          assertHistoryCurrent,
          bridge,
          { origin: "mobile", producer: "mobile-chat" },
          request,
          externalTarget?.submit,
        ),
    });
    const chatReply =
      external && event.viewerId
        ? (e: MobileServerEvent) => ctx.remote.sendToViewer(event.viewerId!, e)
        : reply;
    if (!dispatched.ok) {
      if (dispatched.uncertain) {
        // Older clients ignore this additive event and keep waiting for their
        // existing acknowledgement timeout. A correlated
        // generic error would incorrectly tell them the run was rejected.
        chatReply({
          type: "chat.uncertain",
          sessionId,
          clientMessageId: dispatched.clientMessageId,
          message: dispatched.message,
        });
        return;
      }
      chatReply({
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
    if (!external && event.viewerId && deviceId)
      await ctx.externalCommands?.observe({
        type: "session.select",
        sessionId,
        viewerId: event.viewerId,
        deviceId,
      });
    // External acceptance belongs only to the authenticated submitting tab.
    chatReply({
      type: "chat.accepted",
      sessionId,
      cwd: dispatched.cwd,
      clientMessageId: dispatched.clientMessageId,
      attachments: dispatched.summaries,
      ...(externalTarget?.modelKey ? { modelKey: externalTarget.modelKey } : {}),
    });
    return;
  }
  if (
    ["model.set", "goal.extend", "goal.clear"].includes(event.type) &&
    ctx.externalCommands?.isExternal(
      resolveSessionId("sessionId" in event ? event.sessionId : undefined),
      event.viewerId,
    )
  ) {
    if (event.viewerId)
      ctx.remote.sendToViewer(event.viewerId, {
        type: "error",
        message: "External approval/model/Goal controls require the Desktop owner",
      });
    return;
  }
  if (event.type === "approval.respond") {
    const selectedSessionId = resolveSessionId(event.sessionId);
    if (ctx.externalCommands?.isExternal(selectedSessionId, event.viewerId)) {
      try {
        const settled = await ctx.externalCommands.respondApproval(
          event.viewerId,
          deviceId,
          selectedSessionId,
          event.approvalId,
          {
            approved: event.decision === "approve",
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
            ...(event.answer !== undefined ? { answer: event.answer } : {}),
            ...(event.scope ? { scope: event.scope } : {}),
            ...(event.pathScope ? { pathScope: event.pathScope } : {}),
          },
        );
        if (!settled) throw new Error("审批已结束，或不属于当前会话。");
      } catch (error) {
        if (event.viewerId)
          ctx.remote.sendToViewer(event.viewerId, {
            type: "error",
            approvalId: event.approvalId,
            message: error instanceof Error ? error.message : "审批未提交。",
          });
      }
      return;
    }
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
    const result = await injectAndAwaitResult(
      bridge,
      "agent/approve",
      { sessionId, requestId: event.approvalId, decision },
      { origin: "mobile", producer: "mobile-approval" },
    );
    if (!result.ok) {
      reply({ type: "error", approvalId: event.approvalId, message: result.message });
      return;
    }
    ctx.broadcastApprovalResolved({
      requestId: event.approvalId,
      sessionId,
      approved: event.decision === "approve",
      ...(event.decision === "approve" && event.answer !== undefined
        ? { answer: event.answer }
        : {}),
    });
    return;
  }
  if (event.type === "run.stop") {
    const sessionId = resolveSessionId(event.sessionId);
    if (ctx.externalCommands?.isExternal(sessionId, event.viewerId)) {
      try {
        await ctx.externalCommands.stop(event.viewerId, deviceId, sessionId);
      } catch {
        if (event.viewerId)
          ctx.remote.sendToViewer(event.viewerId, {
            type: "error",
            message: "External cancel authority unavailable",
          });
      }
      return;
    }
    bridge.injectWorkerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `mobile-cancel-${Date.now()}`,
        method: "agent/cancel",
        params: { sessionId: resolveSessionId(event.sessionId) },
      }),
      { origin: "mobile", producer: "mobile-run-stop" },
    );
    return;
  }
  if (event.type === "session.list") {
    // Filter before paging so busy projects cannot hide another project's history.
    const { sessions, nextCursor } = await listDiskSessions({
      limit: 100,
      cursor: event.cursor,
      cwds: event.cwds,
    });
    for (const s of sessions) ctx.mobileSessionCwds.set(s.id, s.cwd || null);
    const activeSessionId = st.selectedSessionId ?? runContext.sessionId;
    const replyPage = (page: MobileServerEvent) =>
      event.viewerId ? ctx.remote.sendToViewer(event.viewerId, page) : reply(page);
    replyPage({
      type: "session.list.ok",
      ...(event.requestId ? { requestId: event.requestId } : {}),
      nextCursor,
      sessions: sessions.flatMap((s) =>
        s.parentSessionId || s.origin === "subagent"
          ? []
          : [
              {
                id: s.id,
                title: s.title,
                cwd: s.cwd,
                updatedAt: s.updatedAt,
                origin: s.origin,
                ...(s.model ? { model: s.model } : {}),
                ...(s.provider ? { provider: s.provider } : {}),
              },
            ],
      ),
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
    if (ctx.externalCommands?.isExternal(event.sessionId, event.viewerId)) {
      if (event.viewerId)
        ctx.remote.sendToViewer(event.viewerId, {
          type: "error",
          message: "External history requires the selected paged output recovery",
        });
      return;
    }
    try {
      const events = await buildSessionHistory(
        event.sessionId,
        getSessionTranscript,
        transcriptUserDisplay,
      );
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
    // External output is sent only through the selected per-socket authority;
    // negotiated peers already receive its head on their bounded journal pages.
    if (ctx.externalCommands?.isExternal(event.sessionId, event.viewerId)) return;
    let snapshot = bridge.getSnapshot(
      event.sessionId,
      typeof event.sinceSeq === "number" ? event.sinceSeq : 0,
    );
    // A cursor from an earlier Main lifetime cannot filter this process's log.
    // Legacy peers omit epochs and retain the original incremental contract.
    if (event.epoch && snapshot.epoch && event.epoch !== snapshot.epoch) {
      snapshot = bridge.getSnapshot(event.sessionId, 0);
    }
    reply({
      type: "session.snapshot",
      sessionId: event.sessionId,
      entries: snapshot.events,
      nextSeq: snapshot.nextSeq,
      ...(snapshot.outputCursor ? { outputCursor: snapshot.outputCursor } : {}),
      ...(snapshot.epoch ? { epoch: snapshot.epoch } : {}),
      ...(snapshot.historicalGap ? { historicalGap: true } : {}),
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
    if (parseExternalRuntimeModelKey(event.model)) {
      reply({ type: "error", message: "请在对话的模型选择器中选择外部运行时。" });
      return;
    }
    // Only confirm the model AFTER the worker actually applied it; an invalid
    // model name must not be shown as the current model. Model is
    // engine-global, so a successful change broadcasts to all devices.
    const res = await injectAndAwaitResult(
      bridge,
      "agent/configure",
      { model: event.model },
      { origin: "mobile", producer: "mobile-model-set" },
    );
    if (res.ok) {
      ctx.remote.broadcast({ type: "model.current", model: event.model });
    } else {
      reply({ type: "error", message: `切换模型失败:${res.message}` });
    }
    return;
  }
  if (event.type === "goal.extend") {
    const res = await injectAndAwaitResult(
      bridge,
      "agent/goalExtend",
      {
        sessionId: event.sessionId,
        addTurns: event.addTurns,
        addTokenBudget: event.addTokenBudget,
        addTimeBudgetMs: event.addTimeBudgetMs,
        addStopBlocks: event.addStopBlocks,
      },
      { origin: "mobile", producer: "mobile-goal-extend" },
    );
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
    const res = await injectAndAwaitResult(
      bridge,
      "agent/goalClear",
      { sessionId: event.sessionId },
      { origin: "mobile", producer: "mobile-goal-clear" },
    );
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
