/**
 * Mobile-remote orchestration — routes authenticated mobile client events
 * (chat / approvals / sessions / rooms / cc-rooms) into the SAME run and
 * permission path the renderer uses, via AgentBridge.injectWorkerMessage.
 * There is no second run loop: chat/approval/cancel become the identical
 * JSON-RPC lines the renderer's preload rpc() would emit, so the core
 * permission engine, goal logic, and snapshots all apply unchanged.
 *
 * Extracted from main/index.ts. The transport primitives (RemoteHostManager,
 * RoomManager, uploads, …) live in @cjhyy/code-shell-server; this glue stays
 * desktop-side because it bridges to the AgentBridge worker, desktop window
 * IPC broadcast, and desktop services (settings, workspaces, transcripts).
 */

import { basename } from "node:path";
import {
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  discoverCodexSessions,
  discoverSessions,
  probeClaudeCli,
  probeCodexCli,
  readCodexRecentHistory,
  readRecentHistory,
  resolveExternalAgentConfig,
} from "@cjhyy/code-shell-capability-coding";
import {
  buildSessionHistory,
  dispatchMobileChatTurn,
  listDiskSessions,
  markAttachmentsSent,
  materializeMobileAttachments,
  mobileTranscriptSubscriberId,
  type ClaimedMobileUpload,
  type MobileClientEvent,
  type MobilePermissionModeSnapshotEntry,
  type MobileProjectMeta,
  type MobileServerEvent,
  type MobileUploadService,
  type PendingMobileApprovals,
  type PermissionMode,
  type RemoteHostManager,
  type RoomManager,
  type RoomPublic,
} from "@cjhyy/code-shell-server";
import { resolveNoRepoCwd, type AgentBridge } from "./agent-bridge.js";
import type { ApprovalBridge } from "./cc-room/approval-bridge.js";
import type { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import { dlog } from "./desktop-logger.js";
import { loadProjects } from "./recents-store.js";
import { getSessionWorkspaceForUi } from "./session-workspace-service.js";
import { readSettings } from "./settings-service.js";
import { getSessionTranscript } from "./transcript-reader.js";

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
interface MobileDeviceState {
  /** Lazily-minted fallback session id for this device's fresh chats. */
  sessionId?: string;
  /** The session this device explicitly selected (overrides everything). */
  selectedSessionId?: string;
  /** The cwd bound to the selected or freshly-created mobile session. */
  selectedCwd?: string | null;
  /** Preset chosen before this device has a concrete session; promoted later. */
  permissionMode?: PermissionMode;
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

function normalizeMobileProjects(projects: unknown): MobileProjectMeta[] {
  if (!Array.isArray(projects)) return [];
  const out: MobileProjectMeta[] = [];
  const seen = new Set<string>();
  for (const item of projects) {
    const p = item as Partial<MobileProjectMeta> | null;
    if (!p || typeof p.path !== "string" || !p.path || seen.has(p.path)) continue;
    seen.add(p.path);
    out.push({
      path: p.path,
      name: typeof p.name === "string" && p.name.trim() ? p.name : basename(p.path),
      ...(typeof p.addedAt === "number" ? { addedAt: p.addedAt } : {}),
      ...(typeof p.pinned === "boolean" ? { pinned: p.pinned } : {}),
    });
  }
  return out;
}

function normalizePermissionMode(raw: unknown): PermissionMode | null {
  return raw === "default" || raw === "acceptEdits" || raw === "bypassPermissions" ? raw : null;
}

function normalizePermissionModeSnapshot(raw: unknown): MobilePermissionModeSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MobilePermissionModeSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = item as { sessionId?: unknown; mode?: unknown } | null;
    const sessionId = typeof row?.sessionId === "string" ? row.sessionId : "";
    const mode = normalizePermissionMode(row?.mode);
    if (!sessionId || !mode || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push({ sessionId, mode });
  }
  return out;
}

export interface MobileRemoteOrchestratorDeps {
  remote: RemoteHostManager;
  uploads: MobileUploadService;
  pendingApprovals: PendingMobileApprovals;
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "respond">;
  transcriptSubscriptions: TranscriptSubscriptionManager;
  /** The agent worker bridge; null until the first window creates it. */
  getBridge: () => AgentBridge | null;
  /** Send an IPC payload to every live desktop window. */
  broadcastToWindows: (channel: string, payload: unknown) => void;
}

export class MobileRemoteOrchestrator {
  /**
   * Legacy in-memory project list (pushed from the renderer's localStorage).
   * Disk recents are the source of truth; this is only a fallback if disk is
   * somehow empty.
   */
  private mobileProjects: MobileProjectMeta[] = [];
  private readonly mobileDeviceStates = new Map<string, MobileDeviceState>();
  private readonly mobileSessionCwds = new Map<string, string | null>();
  private readonly mobilePermissionModes = new Map<string, PermissionMode>();

  constructor(private readonly deps: MobileRemoteOrchestratorDeps) {}

  // ── Projects ───────────────────────────────────────────────────────────────

  async projectList(): Promise<MobileProjectMeta[]> {
    // Disk recents are the source of truth (pinned + soft-delete aware). The
    // legacy in-memory `mobileProjects` (pushed from the renderer's
    // localStorage) is only a fallback if disk is somehow empty — disk wins so
    // a desktop add/remove/pin is reflected on phones and survives restart.
    const projects = await loadProjects().catch(() => []);
    if (projects.length > 0) {
      return projects.map((r) => ({
        path: r.path,
        name: r.name,
        addedAt: r.lastOpenedAt,
        pinned: r.pinned,
      }));
    }
    return this.mobileProjects;
  }

  private async sendProjectList(deviceId?: string): Promise<void> {
    const event: MobileServerEvent = {
      type: "room.projects.ok",
      projects: await this.projectList(),
    };
    if (deviceId) this.deps.remote.sendToDevice(deviceId, event);
    else this.deps.remote.broadcast(event);
  }

  /**
   * After a disk project change (add / remove / pin), push the fresh list to
   * BOTH transports: phones via room.projects.ok, desktop windows via
   * projects:changed (so the renderer re-projects its localStorage cache).
   * Disk is the truth; this is how a desktop edit becomes live on phones and
   * how every window stays synced.
   */
  async broadcastProjects(): Promise<void> {
    const projects = await this.projectList();
    this.deps.remote.broadcast({ type: "room.projects.ok", projects });
    this.deps.broadcastToWindows("projects:changed", projects);
  }

  /** Replace the legacy renderer-pushed project list and re-broadcast it. */
  async updateProjects(projects: unknown): Promise<void> {
    this.mobileProjects = normalizeMobileProjects(projects);
    await this.sendProjectList();
  }

  // ── Permission modes ───────────────────────────────────────────────────────

  /** Replace the desktop-pushed permission-mode snapshot and re-announce. */
  updatePermissionModes(entries: unknown): void {
    const next = normalizePermissionModeSnapshot(entries);
    this.mobilePermissionModes.clear();
    for (const entry of next) this.mobilePermissionModes.set(entry.sessionId, entry.mode);
    this.sendSelectedMobilePermissionModes();
  }

  private sendMobilePermissionMode(deviceId: string | undefined, sessionId: string): void {
    const event: MobileServerEvent = {
      type: "permission.mode",
      sessionId,
      mode: this.mobilePermissionModes.get(sessionId) ?? "default",
    };
    if (deviceId) this.deps.remote.sendToDevice(deviceId, event);
    else this.deps.remote.broadcast(event);
  }

  private sendSelectedMobilePermissionModes(): void {
    for (const [deviceId, st] of this.mobileDeviceStates) {
      const sessionId = st.selectedSessionId ?? st.sessionId;
      if (sessionId) this.sendMobilePermissionMode(deviceId, sessionId);
    }
  }

  private broadcastDesktopPermissionMode(params: {
    sessionId: string;
    mode: PermissionMode;
  }): void {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/mobilePermissionMode",
      params,
    });
    this.deps.broadcastToWindows("agent:msg", line);
  }

  // ── Approvals ──────────────────────────────────────────────────────────────

  private replayPendingMobileApprovals(sessionId: string, deviceId?: string): void {
    for (const line of this.deps.pendingApprovals.replayLines(sessionId)) {
      if (deviceId) this.deps.remote.sendRawToDevice(deviceId, line);
      else this.deps.remote.broadcastRaw(line);
    }
  }

  broadcastApprovalResolved(params: {
    requestId: string;
    sessionId?: string;
    approved?: boolean;
  }): void {
    this.deps.pendingApprovals.resolve(params.requestId);
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/approvalResolved",
      params,
    });
    this.deps.broadcastToWindows("agent:msg", line);
    this.deps.remote.broadcast({
      type: "approval.resolved",
      approvalId: params.requestId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.approved !== undefined ? { approved: params.approved } : {}),
    });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private broadcastMobileSession(meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    clientMessageId?: string;
  }): void {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/mobileSession",
      params: meta,
    });
    this.deps.broadcastToWindows("agent:msg", line);
  }

  private deviceState(deviceId: string): MobileDeviceState {
    let s = this.mobileDeviceStates.get(deviceId);
    if (!s) {
      s = {};
      this.mobileDeviceStates.set(deviceId, s);
    }
    return s;
  }

  /**
   * A stable session id for the mobile client when it isn't following a
   * specific desktop session. The worker's multi-session path REQUIRES a
   * non-empty sessionId on agent/run (server.ts: "sessionId is required") —
   * sending undefined is exactly the "session id 没有" error. We lazily mint
   * one and reuse it so the phone's turns land in one coherent session. A
   * phone that explicitly selects a session (session.select) overrides this.
   */
  private ensureMobileSessionId(st: MobileDeviceState): string {
    if (!st.sessionId) {
      st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return st.sessionId;
  }

  private async lookupDiskSessionCwd(sessionId: string): Promise<string | null | undefined> {
    const cached = this.mobileSessionCwds.get(sessionId);
    if (cached !== undefined) return cached;
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await listDiskSessions({ limit: 100, cursor }).catch(() => ({
        sessions: [],
        nextCursor: null,
      }));
      for (const s of res.sessions) {
        this.mobileSessionCwds.set(s.id, s.cwd || null);
        if (s.id === sessionId || s.engineSessionId === sessionId) {
          const cwd = s.cwd || null;
          this.mobileSessionCwds.set(sessionId, cwd);
          return cwd;
        }
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return undefined;
  }

  private effectiveMobileRunCwd(st: MobileDeviceState, ctxCwd?: string): string {
    if (st.selectedCwd === null) return resolveNoRepoCwd();
    return st.selectedCwd || ctxCwd || process.cwd();
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  /**
   * Route an authenticated mobile client event into the SAME run/permission
   * path the renderer uses, via AgentBridge.injectWorkerMessage.
   */
  async handleMobileClientEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
    if (event.type === "attachment.upload.begin") {
      const deviceId = event.deviceId;
      if (!deviceId) return;
      try {
        const ticket = this.deps.uploads.begin(deviceId, {
          clientId: event.clientId,
          name: event.name,
          mime: event.mime,
          size: event.size,
        });
        this.deps.remote.sendToDevice(deviceId, { type: "attachment.upload.ready", ...ticket });
      } catch (error) {
        this.deps.remote.sendToDevice(deviceId, {
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
      await this.handleCcRoomEvent(event);
      return;
    }
    // ── Rooms (independent of the chat worker bridge) ─────────────────────
    if (event.type.startsWith("room.")) {
      await this.handleRoomEvent(event);
      return;
    }
    const bridge = this.deps.getBridge();
    if (!bridge) return;
    const ctx = bridge.getLastRunContext();
    // Per-device state: the remote host tags every authenticated event with the
    // device id (see onClientEvent wiring). Replies that are device-specific go
    // back to ONLY that device via sendToDevice; the agent output stream is
    // still broadcast (each front-end filters to its bound session).
    const deviceId = event.deviceId;
    const st = deviceId ? this.deviceState(deviceId) : {};
    const reply = (e: MobileServerEvent): void => {
      if (deviceId) this.deps.remote.sendToDevice(deviceId, e);
      else this.deps.remote.broadcast(e);
    };
    // session selection priority: explicit per-event → this device's selection →
    // desktop's current run → a stable minted per-device session.
    const resolveSessionId = (explicit?: string): string =>
      explicit ?? st.selectedSessionId ?? ctx.sessionId ?? this.ensureMobileSessionId(st);
    if (event.type === "session.select") {
      st.selectedSessionId = event.sessionId;
      const cwd = await this.lookupDiskSessionCwd(event.sessionId);
      if (cwd !== undefined) st.selectedCwd = cwd;
      if (deviceId) this.sendMobilePermissionMode(deviceId, event.sessionId);
      else {
        reply({
          type: "permission.mode",
          sessionId: event.sessionId,
          mode: this.mobilePermissionModes.get(event.sessionId) ?? "default",
        });
      }
      this.replayPendingMobileApprovals(event.sessionId, deviceId);
      return;
    }
    if (event.type === "session.create") {
      // Mint a fresh session for THIS device and make it its active selection.
      st.sessionId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      st.selectedSessionId = st.sessionId;
      if ("cwd" in event) {
        st.selectedCwd = event.cwd ?? null;
      } else {
        st.selectedCwd = ctx.cwd ?? process.cwd();
      }
      this.mobileSessionCwds.set(st.sessionId, st.selectedCwd);
      if (st.permissionMode) this.mobilePermissionModes.set(st.sessionId, st.permissionMode);
      reply({ type: "chat.accepted", sessionId: st.sessionId, cwd: st.selectedCwd });
      if (deviceId) this.sendMobilePermissionMode(deviceId, st.sessionId);
      else {
        reply({
          type: "permission.mode",
          sessionId: st.sessionId,
          mode: this.mobilePermissionModes.get(st.sessionId) ?? "default",
        });
      }
      return;
    }
    if (event.type === "chat.send") {
      const sessionId = resolveSessionId(event.sessionId);
      const fallbackCwd = this.effectiveMobileRunCwd(st, ctx.cwd);
      if (st.permissionMode && !this.mobilePermissionModes.has(sessionId)) {
        this.mobilePermissionModes.set(sessionId, st.permissionMode);
      }
      const permissionMode = this.mobilePermissionModes.get(sessionId);
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
        uploads: this.deps.uploads,
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
      this.mobileSessionCwds.set(sessionId, dispatched.cwd);
      const title = text || `图片 ${dispatched.metas.length} 张`;
      this.broadcastMobileSession({
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
      this.broadcastApprovalResolved({
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
      for (const s of sessions) this.mobileSessionCwds.set(s.id, s.cwd || null);
      const activeSessionId = st.selectedSessionId ?? ctx.sessionId;
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
        if (deviceId) this.sendMobilePermissionMode(deviceId, activeSessionId);
        else {
          reply({
            type: "permission.mode",
            sessionId: activeSessionId,
            mode: this.mobilePermissionModes.get(activeSessionId) ?? "default",
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
      this.replayPendingMobileApprovals(event.sessionId, deviceId);
      return;
    }
    if (event.type === "permission.setMode") {
      const sessionId = event.sessionId ?? st.selectedSessionId;
      if (sessionId) {
        this.mobilePermissionModes.set(sessionId, event.mode);
        this.sendSelectedMobilePermissionModes();
        this.broadcastDesktopPermissionMode({ sessionId, mode: event.mode });
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
        this.deps.remote.broadcast({ type: "model.current", model: event.model });
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

  // ── Rooms ──────────────────────────────────────────────────────────────────

  roomToPublic(room: {
    id: string;
    name: string;
    cwd: string;
    kind: "claude-code" | "codex";
    permissionMode: "default" | "acceptEdits" | "bypassPermissions";
    createdAt: number;
    lastActiveAt: number;
  }): RoomPublic {
    return { ...room, open: this.deps.roomManager.isOpen(room.id) };
  }

  roomMatchesTranscript(
    roomId: string,
    cwd: string,
    sessionId: string,
    kind: "claude-code" | "codex",
  ): boolean {
    const room = this.deps.roomManager.getRoom(roomId);
    return Boolean(
      room && room.cwd === cwd && room.claudeSessionId === sessionId && room.kind === kind,
    );
  }

  /**
   * Handle a room.* mobile event. Rooms are resident stream-json Claude Code
   * sessions; they do not go through the chat worker bridge. permissionMode
   * for a non-trusted cwd that requests bypassPermissions is downgraded to
   * "default" here (the high-risk gate is surfaced by the UI / future
   * approval step).
   */
  private async handleRoomEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
    const reply = (serverEvent: MobileServerEvent): void => {
      if (event.deviceId) this.deps.remote.sendToDevice(event.deviceId, serverEvent);
      else this.deps.remote.broadcast(serverEvent);
    };
    try {
      if (event.type === "room.list") {
        this.deps.remote.broadcast({
          type: "room.list.ok",
          rooms: this.deps.roomManager.listRooms().map((room) => this.roomToPublic(room)),
        });
        return;
      }
      if (event.type === "room.projects") {
        await this.sendProjectList(event.deviceId);
        return;
      }
      if (event.type === "room.create") {
        const permissionMode = await resolveRoomPermissionMode(event.cwd, event.permissionMode);
        const room = this.deps.roomManager.createRoom({
          name: event.name,
          cwd: event.cwd,
          kind: event.kind,
          permissionMode,
        });
        const opened = this.deps.roomManager.open(room.id);
        this.deps.remote.broadcast({
          type: "room.list.ok",
          rooms: this.deps.roomManager.listRooms().map((r) => this.roomToPublic(r)),
        });
        this.deps.remote.broadcast({ type: "room.opened", roomId: room.id, status: opened.status });
        return;
      }
      if (event.type === "room.open") {
        const res = this.deps.roomManager.open(event.roomId);
        this.deps.remote.broadcast({
          type: "room.opened",
          roomId: event.roomId,
          status: res.status,
        });
        return;
      }
      if (event.type === "room.close") {
        this.deps.roomManager.close(event.roomId);
        this.deps.remote.broadcast({ type: "room.closed", roomId: event.roomId });
        return;
      }
      if (event.type === "room.history") {
        const messages = this.deps.roomManager.getMessages(event.roomId, event.sinceSeq ?? 0);
        const latestSeq = messages.length
          ? messages[messages.length - 1]!.seq
          : (event.sinceSeq ?? 0);
        this.deps.remote.broadcast({
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
        const room = this.deps.roomManager.getRoom(event.roomId);
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
          uploads: this.deps.uploads,
        });
        let ok: boolean;
        try {
          ok = this.deps.roomManager.send(event.roomId, text, materialized.metas);
        } catch (error) {
          await this.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
          throw error;
        }
        if (!ok) {
          await this.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "release");
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
        await this.settleMobileUploadClaims(event.deviceId ?? "", materialized.claims, "finalize");
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

  private async settleMobileUploadClaims(
    deviceId: string,
    claims: ClaimedMobileUpload[],
    action: "release" | "finalize",
  ): Promise<void> {
    const results = await Promise.allSettled(
      claims.map((claim) => this.deps.uploads[action](deviceId, claim.uploadId, claim.claimId)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      dlog("main", `mobile.attachment_claim.${action}_failed`, {
        count: failures.length,
        errors: failures.map((result) => String(result.reason)),
      });
    }
  }

  /**
   * CC Room (external `claude` CLI sessions) for mobile — mirrors the desktop
   * ccRoom:* IPC handlers, reusing the SAME core discovery + roomManager
   * backend. Discovery replies (probe/listSessions/readHistory) go per-device;
   * open and approval-response feed the shared roomManager / approvalBridge
   * (the room is dual-ended, like desktop). listSessions echoes the cwd so a
   * phone that has since switched projects can discard a stale reply.
   */
  private async handleCcRoomEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
    const deviceId = event.deviceId;
    const reply = (e: MobileServerEvent): void => {
      if (deviceId) this.deps.remote.sendToDevice(deviceId, e);
      else this.deps.remote.broadcast(e);
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
        const sessions =
          kind === "codex"
            ? discoverCodexSessions(event.cwd, undefined, opts)
            : discoverSessions(event.cwd, undefined, opts);
        reply({ type: "ccRoom.listSessions.ok", cwd: event.cwd, sessions, kind });
        return;
      }
      if (event.type === "ccRoom.openSession") {
        const mode = await resolveRoomPermissionMode(event.cwd, event.mode);
        const { roomId, status } = this.deps.roomManager.openForSession(
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
        if (!this.roomMatchesTranscript(event.roomId, event.cwd, event.sessionId, kind)) {
          throw new Error("cc-room transcript subscription does not match the opened room");
        }
        const snapshot = this.deps.transcriptSubscriptions.subscribe({
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
        this.deps.transcriptSubscriptions.unsubscribe(
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
        this.deps.approvalBridge.respond(event.roomId, event.requestId, event.decision);
        return;
      }
    } catch (err) {
      reply({ type: "room.error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}
