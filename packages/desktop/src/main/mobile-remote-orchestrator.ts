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
import { Methods } from "@cjhyy/code-shell-core";
import { listDiskSessions } from "@cjhyy/code-shell-server/storage";
import {
  type ClaimedMobileUpload,
  type MobilePermissionModeSnapshotEntry,
  type MobileProjectMeta,
  type MobileServerEvent,
  type MobileUploadService,
  type PendingMobileApprovals,
  type PermissionMode,
  type RemoteHostManager,
  type RoomManager,
  type RoomPublic,
} from "@cjhyy/code-shell-server/mobile-remote";
import { resolveNoRepoCwd, type AgentBridge } from "./agent-bridge.js";
import type { ApprovalBridge } from "./cc-room/approval-bridge.js";
import type { TranscriptSubscriptionManager } from "./cc-room/transcript-subscriptions.js";
import { dlog } from "./desktop-logger.js";
import {
  handleClientEvent,
  type AuthenticatedMobileClientEvent,
  type MobileDeviceState,
  type OrchestratorCtx,
} from "./mobile-remote/handle-client-event.js";
import { loadProjects } from "./recents-store.js";

export { injectAndAwaitResult } from "./mobile-remote/handle-client-event.js";
export { resolveRoomPermissionMode } from "./mobile-remote/handle-room-event.js";
export type { AuthenticatedMobileClientEvent } from "./mobile-remote/handle-client-event.js";

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
      method: Methods.ApprovalResolved,
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

  private ctx(): OrchestratorCtx {
    return {
      remote: this.deps.remote,
      uploads: this.deps.uploads,
      roomManager: this.deps.roomManager,
      approvalBridge: this.deps.approvalBridge,
      transcriptSubscriptions: this.deps.transcriptSubscriptions,
      getBridge: () => this.deps.getBridge(),
      mobileSessionCwds: this.mobileSessionCwds,
      mobilePermissionModes: this.mobilePermissionModes,
      deviceState: (deviceId) => this.deviceState(deviceId),
      ensureMobileSessionId: (state) => this.ensureMobileSessionId(state),
      lookupDiskSessionCwd: (sessionId) => this.lookupDiskSessionCwd(sessionId),
      effectiveMobileRunCwd: (state, contextCwd) => this.effectiveMobileRunCwd(state, contextCwd),
      sendMobilePermissionMode: (deviceId, sessionId) =>
        this.sendMobilePermissionMode(deviceId, sessionId),
      sendSelectedMobilePermissionModes: () => this.sendSelectedMobilePermissionModes(),
      replayPendingMobileApprovals: (sessionId, deviceId) =>
        this.replayPendingMobileApprovals(sessionId, deviceId),
      broadcastDesktopPermissionMode: (params) => this.broadcastDesktopPermissionMode(params),
      broadcastMobileSession: (meta) => this.broadcastMobileSession(meta),
      broadcastApprovalResolved: (params) => this.broadcastApprovalResolved(params),
      roomToPublic: (room) => this.roomToPublic(room),
      roomMatchesTranscript: (roomId, cwd, sessionId, kind) =>
        this.roomMatchesTranscript(roomId, cwd, sessionId, kind),
      sendProjectList: (deviceId) => this.sendProjectList(deviceId),
      settleMobileUploadClaims: (deviceId, claims, action) =>
        this.settleMobileUploadClaims(deviceId, claims, action),
    };
  }

  /**
   * Route an authenticated mobile client event into the SAME run/permission
   * path the renderer uses, via AgentBridge.injectWorkerMessage.
   */
  async handleMobileClientEvent(event: AuthenticatedMobileClientEvent): Promise<void> {
    return handleClientEvent(this.ctx(), event);
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
}
