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

import { Methods, sessionsRoot } from "@cjhyy/code-shell-core";
import { MobilePermissionModes } from "./mobile-remote/permission-modes.js";
import { MobileNativeSubmissions } from "./mobile-remote/native-submissions.js";
import { MobileOutputRecovery } from "./mobile-remote/output-recovery.js";
import {
  mobileOutputRecoveryAuthority,
  mobileSessionCommandAuthority,
  mobileNewSessionAuthority,
} from "./mobile-remote/output-recovery-authority.js";
import {
  MobileExternalRuntimeCommands,
  isPersistedExternalRuntime,
  persistedExternalRuntimeModelKey,
  type MobileRuntimeStart,
} from "./mobile-remote/external-runtime-commands.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import type {
  ExternalApprovalEvent,
  ExternalRuntimeApprovals,
} from "./external-runtime-approvals.js";
import type { ExternalRuntimeModelEntry } from "../shared/external-runtime-models.js";
import { SessionManager } from "@cjhyy/code-shell-core";
import { requireRendererProjectEntryPath } from "./renderer-project-path.js";
import type { OwnedExternalStreamEntry } from "./owned-external-stream.js";
import {
  type ClaimedMobileUpload,
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
import { getProjectStore } from "./project-store.js";
import { toMobileProjectMeta } from "./mobile-project-meta.js";
import type {
  OutputHistoryRecoveryAuthorization,
  OutputHistoryRecoveryCaller,
} from "./session-output-history-recovery.js";
import type { MobileOutputHistoryService } from "./mobile-remote/output-history-commands.js";
import {
  MobileTurnQueueHost,
  runQueuedDispatch,
  type QueueableMobileSend,
  type QueuedDispatch,
  type QueuedSessionAuthority,
} from "./mobile-remote/turn-queue-host.js";
import { onRunStopRequested } from "./run-stop-signals.js";
import type { TurnQueueDispatchResult } from "@cjhyy/code-shell-server/mobile-remote";
export { toMobileProjectMeta } from "./mobile-project-meta.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { lstatSync, realpathSync } from "node:fs";
import { findMainWorktreeRoot } from "@cjhyy/code-shell-capability-coding/git";
import {
  getSessionWorkspaceForUi,
  getSessionWorkspaceAuthorityForUi,
} from "./session-workspace-service.js";

import {
  canonicalRoomDirectory,
  mobileRoomModeRequesterKey,
  type RoomModeAuthority,
} from "./cc-room/room-mode-authority.js";

export { injectAndAwaitResult } from "./mobile-remote/handle-client-event.js";
export type { AuthenticatedMobileClientEvent } from "./mobile-remote/handle-client-event.js";

export interface MobileRemoteOrchestratorDeps {
  remote: RemoteHostManager;
  uploads: MobileUploadService;
  pendingApprovals: PendingMobileApprovals;
  roomManager: RoomManager;
  approvalBridge: Pick<ApprovalBridge, "respond" | "pendingRequests">;
  transcriptSubscriptions: TranscriptSubscriptionManager;
  /** The agent worker bridge; null until the first window creates it. */
  getBridge: () => AgentBridge | null;
  getExternalRuntimeService?: () => ExternalRuntimeService | null;
  getExternalRuntimeModels?: () => Promise<ExternalRuntimeModelEntry[]>;
  startMobileRuntime?: (request: MobileRuntimeStart) => Promise<void>;
  getExternalRuntimeApprovals?: () => ExternalRuntimeApprovals | null;
  /** Host authority for external CLI room permission modes. */
  roomModes?: RoomModeAuthority;
  /** Send an IPC payload to every live desktop window. */
  broadcastToWindows: (channel: string, payload: unknown) => void;
}

export class MobileRemoteOrchestrator {
  private readonly mobileDeviceStates = new Map<string, MobileDeviceState>();
  private readonly mobileSessionCwds = new Map<string, string | null>();
  private readonly mobilePermissionModes = new MobilePermissionModes();

  private readonly outputRecovery: MobileOutputRecovery;
  private readonly externalCommands: MobileExternalRuntimeCommands;
  private readonly nativeSubmissions: MobileNativeSubmissions;
  private outputHistoryRecoveryService?: MobileOutputHistoryService;
  private readonly turnQueue: MobileTurnQueueHost;
  constructor(private readonly deps: MobileRemoteOrchestratorDeps) {
    this.externalCommands = new MobileExternalRuntimeCommands({
      authenticated: (viewer, device) => deps.remote.hasAuthenticatedViewer(viewer, device),
      authority: mobileSessionCommandAuthority,
      owner: (id) => deps.getBridge()?.panelOwnerWebContentsId(id),
      ownerRevision: (id) => deps.getBridge()?.sessionPanelOwnerRevision(id),
      service: () => deps.getExternalRuntimeService?.() ?? null,
      isExternal: (id) =>
        !!deps.getExternalRuntimeService?.()?.hasSession(id) ||
        isPersistedExternalRuntime(new SessionManager().readSessionState(id)),
      exists: (id) => !!new SessionManager().readSessionState(id),
      attachmentPath: requireRendererProjectEntryPath,
      modelKey: (id) => persistedExternalRuntimeModelKey(new SessionManager().readSessionState(id)),
      startRuntime: deps.startMobileRuntime,
      approvals: deps.getExternalRuntimeApprovals,
      approvalEvent: (viewer, event) => {
        if (event.type === "requested")
          deps.remote.sendRawToViewer(
            viewer,
            JSON.stringify({
              jsonrpc: "2.0",
              method: "agent/approvalRequest",
              params: {
                sessionId: event.sessionId,
                requestId: event.requestId,
                request: event.request,
              },
            }),
          );
        else
          deps.remote.sendToViewer(viewer, {
            type: "approval.resolved",
            approvalId: event.requestId,
            sessionId: event.sessionId,
            ...(event.approved !== undefined ? { approved: event.approved } : {}),
            ...(event.answer !== undefined ? { answer: event.answer } : {}),
          });
      },
    });
    this.nativeSubmissions = new MobileNativeSubmissions(this.externalCommands);
    this.outputRecovery = new MobileOutputRecovery({
      root: sessionsRoot,
      hasLiveExternalProducer: (id) => !!deps.getExternalRuntimeService?.()?.hasSession(id),
      journalRequired: (id) =>
        !!deps.getExternalRuntimeService?.()?.hasSession(id) ||
        isPersistedExternalRuntime(new SessionManager().readSessionState(id)),
      authority: mobileOutputRecoveryAuthority,
      snapshot: (id, sinceSeq = 0) => this.deps.getBridge()?.getSnapshot(id, sinceSeq),
      reply: (viewer, event) => this.deps.remote.sendToViewer(viewer, event),
      owner: (id) => this.deps.getBridge()?.panelOwnerWebContentsId(id),
      ownerRevision: (id) => this.deps.getBridge()?.sessionPanelOwnerRevision(id),
      authenticated: (viewer, device) => this.deps.remote.hasAuthenticatedViewer(viewer, device),
    });
    this.turnQueue = new MobileTurnQueueHost({
      remote: deps.remote,
      uploads: deps.uploads,
      isSessionBusy: (id) =>
        !!deps.getBridge()?.isSessionRunning(id) ||
        !!deps.getExternalRuntimeService?.()?.isRunActive(id),
      isSessionAuthorized: (viewer, device, sessionId) =>
        this.selectedSessionAuthorized(viewer, device, sessionId),
      captureSession: (viewer, device, event) => this.captureQueuedSession(viewer, device, event),
      room: (roomId) => {
        const room = deps.roomManager.getRoom(roomId);
        return room
          ? {
              observing: room.linkedSessionMode === "observe-only",
              mode: deps.roomManager.effectiveMode(roomId),
              busy: deps.roomManager.isExecutionBusy(roomId),
            }
          : undefined;
      },
      submit: (dispatch) => this.submitQueuedTurn(dispatch),
    });
    // Mode changes are refused while turns submitted under the current mode are
    // pending; an explicit close (any view) pauses them before the signal.
    deps.roomManager.setHostTurnHooks?.({
      hasPendingTurns: (roomId) => this.turnQueue.hasPendingTurns({ kind: "room", roomId }),
      beforeClose: (roomId) => this.turnQueue.pauseForStop({ kind: "room", roomId }),
    });
    // Any stop of a Session run (Desktop, phone, task inbox) pauses its pending turns.
    onRunStopRequested((sessionId) => this.turnQueue.pauseForStop({ kind: "session", sessionId }));
    // This command Host owns the FIFO, so it advertises the client capability.
    deps.remote.advertiseTurnQueue?.();
  }

  private selectedSessionAuthorized(viewer: string, device: string, sessionId: string): boolean {
    try {
      this.externalCommands.captureSelectedAuthority(viewer, device, sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The authority a Session turn is admitted under: the tab's selection proves
   * it now; the Session/project stamp and the device's project binding are
   * kept so the turn can run later without that tab, and is refused if any of
   * them changed. External runtimes and native connection choices stay bound
   * to a live tab of the same device (the Host does not act for a device).
   */
  private async captureQueuedSession(
    viewer: string,
    device: string,
    event: Extract<QueueableMobileSend, { type: "chat.send" }>,
  ): Promise<QueuedSessionAuthority | undefined> {
    const sessionId = event.sessionId;
    if (!sessionId || !this.selectedSessionAuthorized(viewer, device, sessionId)) return undefined;
    const state = this.mobileDeviceStates.get(device);
    const deviceState: MobileDeviceState = {
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
      selectedSessionId: sessionId,
      // A project binding applies only when the device selected this Session.
      ...(state?.selectedSessionId === sessionId
        ? {
            selectedCwd: state.selectedCwd,
            selectedProjectId: state.selectedProjectId,
            ...(state.selectedRootId ? { selectedRootId: state.selectedRootId } : {}),
          }
        : {}),
      ...(state?.permissionMode ? { permissionMode: state.permissionMode } : {}),
    };
    let viewerBound =
      !!event.nativeConnectionId ||
      !!event.modelKey ||
      this.externalCommands.isExternal(sessionId, viewer, sessionId === state?.sessionId);
    let stamp: string | undefined;
    if (!viewerBound) {
      try {
        stamp = (await mobileSessionCommandAuthority(sessionId)).stamp;
      } catch {
        // Not yet a persisted Session: only its live tab may run the turn.
        viewerBound = true;
      }
      if (!this.selectedSessionAuthorized(viewer, device, sessionId)) return undefined;
    }
    return { viewerBound, ...(stamp ? { stamp } : {}), deviceState };
  }

  releaseViewer(viewerId: string): void {
    this.outputRecovery.revoke(viewerId);
    this.externalCommands.revoke(viewerId, true);
    // A disconnected tab cannot keep a mode-change card alive. A room that is
    // already running legitimately is not touched.
    this.deps.roomModes?.cancelRequester(mobileRoomModeRequesterKey(viewerId));
    this.turnQueue.releaseViewer(viewerId);
  }

  /** Installed once by Main's shared Desktop/mobile history composition. */
  setOutputHistoryRecoveryService(service: MobileOutputHistoryService): void {
    this.outputHistoryRecoveryService = service;
  }

  async authorizeOutputHistoryRecovery(
    sessionId: string,
    caller: Extract<OutputHistoryRecoveryCaller, { kind: "mobile" }>,
  ): Promise<OutputHistoryRecoveryAuthorization> {
    if (caller.kind !== "mobile") throw new Error("Invalid mobile recovery caller");
    const bridge = this.deps.getBridge();
    if (!bridge) throw new Error("Session bridge unavailable");
    const ownerRevision = bridge.sessionPanelOwnerRevision(sessionId);
    const selected = this.externalCommands.captureSelectedAuthority(
      caller.viewerId,
      caller.deviceId,
      sessionId,
    );
    const authority = await mobileSessionCommandAuthority(sessionId);
    const owner = bridge.panelOwnerWebContentsId(sessionId);
    const assertCurrent = () => {
      selected.assertCurrent();
      authority.assertCurrent();
      if (
        this.deps.getBridge() !== bridge ||
        bridge.sessionPanelOwnerRevision(sessionId) !== ownerRevision ||
        bridge.panelOwnerWebContentsId(sessionId) !== owner ||
        selected.owner !== owner ||
        selected.stamp !== authority.stamp
      )
        throw new Error("Session recovery authority changed");
    };
    assertCurrent();
    return {
      key: JSON.stringify([
        "mobile",
        caller.viewerId,
        caller.deviceId,
        selected.key,
        authority.stamp,
        owner,
        ownerRevision,
      ]),
      ownerWebContentsId: owner,
      projectId: authority.projectId ?? null,
      assertCurrent,
    };
  }

  /** Every old tab and approval is retired, not just the confirming caller. */
  retireOutputHistorySession(sessionId: string): void {
    const errors: unknown[] = [];
    for (const retire of [
      () => this.outputRecovery.revokeSession(sessionId),
      () => this.externalCommands.revokeSession(sessionId),
      () => this.deps.pendingApprovals.forgetSession(sessionId),
    ]) {
      try {
        retire();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Session recovery retirement failed");
  }

  mirrorOwnedExternalStream(entry: OwnedExternalStreamEntry): void {
    this.outputRecovery.mirrorOwned(entry);
  }

  mirrorExternalApproval(event: ExternalApprovalEvent): void {
    void this.externalCommands.mirrorApproval(event);
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  async projectList(): Promise<MobileProjectMeta[]> {
    return (await getProjectStore().list()).map(toMobileProjectMeta);
  }

  /** HTTP settings/files use the same Main-owned project and session authority as chat. */
  async resolveWebWorkspace(
    input: string | undefined,
    deviceId: string,
  ): Promise<string | undefined> {
    const state = this.deviceState(deviceId);
    const cwd = input ?? this.effectiveMobileRunCwd(state);
    const projects = getProjectStore();
    if (projects.isNoRepoCwd(cwd)) return resolveNoRepoCwd();
    const root = projects.resolveExactRootSync(cwd);
    if (root) return root.cwd;
    // A session may use its own worktree, which is not a separately registered
    // project root. Resolve it from persisted authority, never from an HTTP cwd.
    const candidates = new Set([
      state.selectedSessionId,
      state.sessionId,
      ...[...this.mobileSessionCwds.keys()].filter(
        (id) => getSessionCwdIndex().lookupCached(id)?.workspaceRoot === cwd,
      ),
    ]);
    for (const id of candidates) {
      if (!id) continue;
      try {
        const authority = await getSessionWorkspaceAuthorityForUi(id);
        if (
          authority.rootStatus !== "ok" ||
          authority.workspace.root !== cwd ||
          authority.workspace.kind !== "worktree" ||
          authority.workspace.worktree?.createdBy !== "codeshell" ||
          authority.workspace.worktree.path !== cwd
        )
          continue;
        const directory = lstatSync(cwd);
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        const mainRoot = await findMainWorktreeRoot(cwd);
        if (mainRoot && realpathSync(mainRoot) === realpathSync(authority.mainRoot)) return cwd;
      } catch {
        // Deleted/unmounted sessions do not grant filesystem access.
      }
    }
    return undefined;
  }

  private async sendProjectList(deviceId?: string): Promise<void> {
    const event: MobileServerEvent = {
      type: "room.projects.ok",
      projects: await this.projectList(),
    };
    if (deviceId) this.deps.remote.sendToDevice(deviceId, event);
    else this.deps.remote.broadcast(event);
  }

  /** Push the Main-owned V2 snapshot to phones after a registry mutation. */
  async broadcastProjects(): Promise<void> {
    const projects = await this.projectList();
    this.deps.remote.broadcast({ type: "room.projects.ok", projects });
  }

  // ── Permission modes ───────────────────────────────────────────────────────

  /** Replace the desktop-pushed permission-mode snapshot and re-announce. */
  updatePermissionModes(entries: unknown): void {
    this.mobilePermissionModes.replaceDesktopSnapshot(entries);
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

  private broadcastDesktopSessionSettings(params: {
    sessionId: string;
    permissionMode?: PermissionMode;
    modelKey?: string;
  }): void {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/mobileSessionSettings",
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
    connectionId?: string;
    generation?: number;
    approved?: boolean;
    answer?: string;
  }): void {
    if (params.connectionId === undefined || params.generation === undefined) {
      const pending = params.sessionId
        ? this.deps.pendingApprovals.find(params.sessionId, params.requestId)
        : undefined;
      // New workers publish their own fully routed resolution. An old renderer
      // acknowledgement cannot revoke an unrelated or successor worker request.
      if (!pending || pending.connectionId !== undefined || pending.generation !== undefined)
        return;
    }
    this.deps.pendingApprovals.resolve(params.requestId, params);
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
      ...(params.connectionId !== undefined ? { connectionId: params.connectionId } : {}),
      ...(params.generation !== undefined ? { generation: params.generation } : {}),
      ...(params.approved !== undefined ? { approved: params.approved } : {}),
      ...(params.answer !== undefined ? { answer: params.answer } : {}),
    });
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private broadcastMobileSession(meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    clientMessageId?: string;
    permissionMode?: PermissionMode;
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
    const entry = await getSessionCwdIndex().lookup(sessionId);
    if (!entry) return undefined;
    const cwd = entry.cwd || null;
    this.mobileSessionCwds.set(sessionId, cwd);
    return cwd;
  }

  private effectiveMobileRunCwd(st: MobileDeviceState): string {
    if (st.selectedCwd === null) return resolveNoRepoCwd();
    return st.selectedCwd || resolveNoRepoCwd();
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  private ctx(): OrchestratorCtx {
    return {
      remote: this.deps.remote,
      outputRecovery: this.outputRecovery,
      externalCommands: this.externalCommands,
      nativeSubmissions: this.nativeSubmissions,
      externalRuntimeModels: () => this.deps.getExternalRuntimeModels?.() ?? Promise.resolve([]),
      newSessionAuthority: mobileNewSessionAuthority,
      uploads: this.deps.uploads,
      roomManager: this.deps.roomManager,
      approvalBridge: this.deps.approvalBridge,
      pendingApprovals: this.deps.pendingApprovals,
      transcriptSubscriptions: this.deps.transcriptSubscriptions,
      getBridge: () => this.deps.getBridge(),
      mobileSessionCwds: this.mobileSessionCwds,
      mobilePermissionModes: this.mobilePermissionModes,
      outputHistoryRecovery: this.outputHistoryRecoveryService,
      deviceState: (deviceId) => this.deviceState(deviceId),
      ensureMobileSessionId: (state) => this.ensureMobileSessionId(state),
      lookupDiskSessionCwd: (sessionId) => this.lookupDiskSessionCwd(sessionId),
      effectiveMobileRunCwd: (state) => this.effectiveMobileRunCwd(state),
      resolveMobileProjectRoot: (projectId, rootId) => {
        const resolved = getProjectStore().resolveProjectRootByIdSync(projectId, rootId);
        return {
          projectId: resolved.project.id,
          rootId: resolved.mainRoot.id,
          cwd: resolved.cwd,
        };
      },
      validateMobileSessionCwd: async (cwd) =>
        getProjectStore().isNoRepoCwd(cwd) ||
        getProjectStore().resolveExactRootSync(cwd) !== undefined,
      resolveSessionWorkspaceRoot: (sessionId, fallbackCwd) =>
        getSessionWorkspaceForUi(sessionId, fallbackCwd)
          .then((workspace) => workspace.root)
          .catch(() => fallbackCwd),
      sendMobilePermissionMode: (deviceId, sessionId) =>
        this.sendMobilePermissionMode(deviceId, sessionId),
      sendSelectedMobilePermissionModes: () => this.sendSelectedMobilePermissionModes(),
      replayPendingMobileApprovals: (sessionId, deviceId) =>
        this.replayPendingMobileApprovals(sessionId, deviceId),
      broadcastDesktopSessionSettings: (params) => this.broadcastDesktopSessionSettings(params),
      broadcastMobileSession: (meta) => this.broadcastMobileSession(meta),
      broadcastApprovalResolved: (params) => this.broadcastApprovalResolved(params),
      roomToPublic: (room) => this.roomToPublic(room),
      ...(this.deps.roomModes ? { roomModes: this.deps.roomModes } : {}),
      broadcastRoomState: (roomId) => this.broadcastRoomState(roomId),
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
    this.turnQueue.observeViewer(event.viewerId, event.deviceId);
    if (this.turnQueue.control(event) || (await this.turnQueue.submit(event))) return;
    this.turnQueue.before(event);
    await handleClientEvent(this.ctx(), event);
    this.turnQueue.after(event);
  }

  /**
   * Mirror a persisted room message to phones. The same turn boundaries drive
   * room idle detection for the Host-owned pending-turn FIFO.
   */
  broadcastRoomMessage(roomId: string, message: unknown): void {
    this.deps.remote.broadcast({ type: "room.message", roomId, msg: message });
    this.turnQueue.observeRoomMessage(roomId, message);
  }

  /**
   * Run one queued turn through the unchanged submit path (see turn-queue-host).
   * A detached turn first re-verifies its admission authority (device still
   * trusted, Session/project unchanged, room mode unchanged) and then runs
   * without re-selecting any tab, on the device binding it was admitted with.
   */
  private submitQueuedTurn(dispatch: QueuedDispatch): Promise<TurnQueueDispatchResult> {
    return runQueuedDispatch(dispatch, {
      ctx: this.ctx(),
      isTrustedDevice: (deviceId) => this.deps.remote.isTrustedDevice(deviceId),
      sessionAuthority: mobileSessionCommandAuthority,
      roomMode: (roomId) => this.deps.roomManager.effectiveMode(roomId),
      handle: handleClientEvent,
    });
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
    linkedSessionMode?: "observe-only";
    claudeSessionId?: string;
  }): RoomPublic {
    return {
      ...room,
      open: this.deps.roomManager.isOpen(room.id),
      observing: room.linkedSessionMode === "observe-only",
      ...(room.claudeSessionId ? { sessionId: room.claudeSessionId } : {}),
    };
  }

  /**
   * Publish a room's authoritative mode/status to every phone and Desktop
   * window after it changed, so no view keeps showing the mode it opened with.
   */
  broadcastRoomState(roomId: string): void {
    const room = this.deps.roomManager.getRoom(roomId);
    this.deps.remote.broadcast({
      type: "room.list.ok",
      rooms: this.deps.roomManager.listRooms().map((r) => this.roomToPublic(r)),
    });
    if (room) this.deps.broadcastToWindows("ccRoom:roomState", this.roomToPublic(room));
  }

  roomMatchesTranscript(
    roomId: string,
    cwd: string,
    sessionId: string,
    kind: "claude-code" | "codex",
  ): boolean {
    const room = this.deps.roomManager.getRoom(roomId);
    // Rooms opened through the Host authority store the canonical directory.
    return Boolean(
      room &&
      canonicalRoomDirectory(room.cwd) === canonicalRoomDirectory(cwd) &&
      room.claudeSessionId === sessionId &&
      room.kind === kind,
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
