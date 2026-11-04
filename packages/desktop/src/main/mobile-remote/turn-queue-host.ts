import {
  MobileTurnQueue,
  type MobileServerEvent,
  type MobileTurnQueueTarget,
  type PermissionMode,
  type TurnQueueDispatchResult,
  type TurnQueueEntry,
  type TurnQueueGate,
  type TurnQueueLookup,
} from "@cjhyy/code-shell-server/mobile-remote";
import type {
  AuthenticatedMobileClientEvent,
  MobileDeviceState,
  OrchestratorCtx,
} from "./handle-client-event.js";

export type QueueableMobileSend = Extract<
  AuthenticatedMobileClientEvent,
  { type: "chat.send" } | { type: "room.send" }
>;
type ChatSend = Extract<QueueableMobileSend, { type: "chat.send" }>;
type QueueControl = Extract<
  AuthenticatedMobileClientEvent,
  { type: "queue.sync" | "queue.cancel" | "queue.clear" | "queue.resume" | "queue.retry" }
>;

/** Session authority granted when a turn was admitted, independent of later navigation. */
export interface QueuedSessionAuthority {
  /** Session command authority (project root / Session identity) at admission. */
  stamp?: string;
  /**
   * True when running needs a live tab of the submitting device that is still
   * selected on the Session (external runtime or a native connection choice):
   * the Host never authorizes those on a device's behalf.
   */
  viewerBound: boolean;
  /** The device's project/root binding at admission, never a later selection's. */
  deviceState: MobileDeviceState;
}

interface QueuedTurn {
  event: QueueableMobileSend;
  session?: QueuedSessionAuthority;
  /** Room permission mode the turn was submitted under. */
  roomMode?: PermissionMode;
}

/** One queued turn handed to the original submit path. */
export interface QueuedDispatch extends QueuedTurn {
  deviceId: string;
  /**
   * The submitter is not waiting on this run (it was queued earlier): it runs
   * on its admission authority without acting as, or re-selecting, any tab.
   * A direct run on an idle target keeps the legacy (tab-bound) semantics.
   */
  detached: boolean;
  /** True once the target was stopped (Desktop, phone, close) after this dispatch began. */
  stopped: () => boolean;
}

export interface MobileTurnQueueHostDeps {
  remote: {
    sendToViewer(viewerId: string, event: MobileServerEvent): void;
    sendToDevice(deviceId: string, event: MobileServerEvent): void;
    hasAuthenticatedViewer(viewerId: string, deviceId: string): boolean;
    onlineDeviceIds(): string[];
  };
  uploads?: {
    retain(deviceId: string, uploadId: string): void;
    discard(deviceId: string, uploadId: string): Promise<void>;
  };
  /** Native worker run or external provider run of this exact Session. */
  isSessionBusy(sessionId: string): boolean;
  /** The tab's current command selection authorizes this Session. */
  isSessionAuthorized(viewerId: string, deviceId: string, sessionId: string): boolean;
  /** Capture the admission authority of a Session turn; undefined keeps the legacy path. */
  captureSession(
    viewerId: string,
    deviceId: string,
    event: ChatSend,
  ): Promise<QueuedSessionAuthority | undefined>;
  /**
   * Authoritative room facts. `busy` is the room's own execution state
   * (active/queued CLI inputs, live Codex turn child, approvals, mode handoff,
   * retiring process) and never counts Host-held turns.
   */
  room(roomId: string): { observing: boolean; mode?: PermissionMode; busy: boolean } | undefined;
  /** Replay through the ORIGINAL submit path and report its admission reply. */
  submit(dispatch: QueuedDispatch): Promise<TurnQueueDispatchResult>;
  intervalMs?: number;
  settleMs?: number;
  now?: () => number;
}

type ReplyTransport = {
  sendToViewer(viewerId: string, event: MobileServerEvent): void;
  sendToDevice(deviceId: string, event: MobileServerEvent): void;
  broadcast(event: MobileServerEvent): void;
};

/**
 * Run one queued turn through its unchanged submit path and capture the
 * admission reply it emits for this clientMessageId. Every reply is still
 * delivered exactly as before; no reply means the path declined before
 * producing one (e.g. no worker bridge yet), so nothing ran.
 */
export async function submitThroughOriginalPath<R extends ReplyTransport>(
  remote: R,
  event: QueueableMobileSend,
  run: (remote: R) => Promise<void>,
): Promise<TurnQueueDispatchResult> {
  const id = event.clientMessageId;
  let outcome: TurnQueueDispatchResult | undefined;
  const observe = (reply: MobileServerEvent): void => {
    if (outcome || !("clientMessageId" in reply) || reply.clientMessageId !== id) return;
    if (reply.type === "chat.accepted" || reply.type === "room.accepted") outcome = { ok: true };
    else if (reply.type === "chat.uncertain")
      outcome = { ok: false, uncertain: true, message: reply.message };
    else if (reply.type === "room.error" && reply.uncertain)
      outcome = { ok: false, uncertain: true, message: reply.message };
    else if (reply.type === "error" || reply.type === "room.error")
      outcome = { ok: false, message: reply.message };
  };
  const intercepted = new Proxy(remote, {
    get(target, property) {
      if (property === "sendToViewer")
        return (viewerId: string, reply: MobileServerEvent) => {
          observe(reply);
          target.sendToViewer(viewerId, reply);
        };
      if (property === "sendToDevice")
        return (deviceId: string, reply: MobileServerEvent) => {
          observe(reply);
          target.sendToDevice(deviceId, reply);
        };
      if (property === "broadcast")
        return (reply: MobileServerEvent) => {
          observe(reply);
          target.broadcast(reply);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await run(intercepted);
  } catch (error) {
    // A throw after an admission reply keeps that reply's meaning.
    const message = error instanceof Error ? error.message : String(error);
    return outcome ?? { ok: false, message };
  }
  return outcome ?? { ok: false, message: "桌面暂时无法接收这条消息，请稍后重试。" };
}

const STOPPED_BEFORE_INPUT = "当前任务已停止，这条排队消息没有发送，已暂停等待继续执行。";
const DEVICE_REVOKED = "提交设备已被撤销或移除，这条排队消息没有执行。";
const AUTHORITY_CHANGED = "会话或项目授权已变化，这条排队消息没有执行。";
const ROOM_MODE_CHANGED =
  "CLI 会话的权限模式已变化，这条排队消息没有按新模式执行。请确认后重新发送。";

class QueuedAdmissionError extends Error {
  constructor(
    message: string,
    readonly stopped: boolean,
  ) {
    super(message);
  }
}

/**
 * Run one queued turn through the original handler. A detached turn runs on
 * the authority it was admitted with: the device must still be trusted, the
 * Session/project authority unchanged (asynchronous lookups are re-verified
 * first, then held as a synchronous assertion), the room mode unchanged and
 * the target not stopped since dispatch began. That whole admission is
 * asserted again, synchronously, immediately before the original handler
 * physically submits (worker injection, runtime start/input, room open/send),
 * so no awaited step in between (workspace, image staging) can outlast a
 * revocation or Stop. It runs on the device binding it was admitted with and
 * never re-selects (takes over) any tab's navigation. Approval and permission
 * checks of the original path are untouched.
 */
export async function runQueuedDispatch(
  dispatch: QueuedDispatch,
  deps: {
    ctx: OrchestratorCtx;
    isTrustedDevice: (deviceId: string) => boolean;
    /** Current Session command authority: its stamp and a synchronous re-check. */
    sessionAuthority: (sessionId: string) => Promise<{ stamp: string; assertCurrent: () => void }>;
    roomMode: (roomId: string) => PermissionMode | undefined;
    handle: (ctx: OrchestratorCtx, event: QueueableMobileSend) => Promise<void>;
  },
): Promise<TurnQueueDispatchResult> {
  const { event } = dispatch;
  let ctx = deps.ctx;
  if (!dispatch.detached)
    return submitThroughOriginalPath(ctx.remote, event, (remote) =>
      deps.handle({ ...ctx, remote }, event),
    );
  let sessionAuthority: { assertCurrent: () => void } | undefined;
  if (event.type === "chat.send" && dispatch.session?.stamp) {
    try {
      const current = await deps.sessionAuthority(event.sessionId!);
      if (current.stamp === dispatch.session.stamp) sessionAuthority = current;
    } catch {
      sessionAuthority = undefined;
    }
    if (!sessionAuthority) return { ok: false, message: AUTHORITY_CHANGED };
  }
  let fenced: QueuedAdmissionError | undefined;
  const assertAdmission = (): void => {
    let failure: QueuedAdmissionError | undefined;
    if (dispatch.stopped()) failure = new QueuedAdmissionError(STOPPED_BEFORE_INPUT, true);
    else if (!deps.isTrustedDevice(dispatch.deviceId))
      failure = new QueuedAdmissionError(DEVICE_REVOKED, false);
    else if (event.type === "room.send" && deps.roomMode(event.roomId) !== dispatch.roomMode)
      failure = new QueuedAdmissionError(ROOM_MODE_CHANGED, false);
    else {
      try {
        sessionAuthority?.assertCurrent();
      } catch {
        failure = new QueuedAdmissionError(AUTHORITY_CHANGED, false);
      }
    }
    if (!failure) return;
    fenced ??= failure;
    throw failure;
  };
  try {
    assertAdmission();
  } catch (error) {
    const failure = error as QueuedAdmissionError;
    return failure.stopped
      ? { ok: false, requeue: true, message: failure.message }
      : { ok: false, message: failure.message };
  }
  const commands = ctx.externalCommands;
  const frozen = dispatch.session?.deviceState;
  ctx = {
    ...ctx,
    ...(commands
      ? {
          externalCommands: new Proxy(commands, {
            get(target, property) {
              if (property === "observe") return async () => undefined;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        }
      : {}),
    ...(frozen ? { deviceState: () => ({ ...frozen }) } : {}),
    beforePhysicalSubmit: assertAdmission,
  };
  const result = await submitThroughOriginalPath(ctx.remote, event, (remote) =>
    deps.handle({ ...ctx, remote }, event),
  );
  // The fence threw before any physical submission: report its own outcome.
  // (An accepted result means the input was handed over before any Stop; that
  // Stop then cancels it as the current run.)
  if (!result.ok && fenced)
    return fenced.stopped
      ? { ok: false, requeue: true, message: fenced.message }
      : { ok: false, message: fenced.message };
  return result;
}

const VIEWER_BOUND_AWAY =
  "外部运行时或所选模型需要提交设备在此会话中在线后才能继续；Host 不会代为授权。";

/** Content identity of a submission; a reused intent id with other content is refused. */
function fingerprint(event: QueueableMobileSend): string {
  return JSON.stringify([
    typeof event.text === "string" ? event.text.trim() : "",
    (event.attachments ?? []).map((item) => [
      item.clientId,
      item.name,
      item.mime,
      item.size,
      item.transport === "upload" ? item.uploadId : item.dataUrl.length,
    ]),
  ]);
}

/**
 * Desktop composition of the Host FIFO: authoritative busy probes, the
 * admission authority each turn runs on, and per-viewer state publication.
 */
export class MobileTurnQueueHost {
  readonly queue: MobileTurnQueue<QueuedTurn>;
  private readonly viewers = new Map<string, string>();

  constructor(private readonly deps: MobileTurnQueueHostDeps) {
    this.queue = new MobileTurnQueue<QueuedTurn>({
      isBusy: (target) => this.isBusy(target),
      canDispatch: (entry) => this.gate(entry),
      dispatch: (entry) => {
        const { event, session, roomMode } = entry.payload;
        const { queue: _queue, viewerId: _viewerId, ...rest } = event;
        const detached = !entry.transient;
        // Only a tab-bound Session turn acts through a (same-device) tab; a
        // detached room or Session turn must not retarget any tab's selection.
        const viewerId =
          !detached || (event.type === "chat.send" && session?.viewerBound)
            ? entry.viewerId
            : undefined;
        const generation = this.queue.stopGeneration(entry.target);
        return deps.submit({
          event: { ...rest, ...(viewerId ? { viewerId } : {}) } as QueueableMobileSend,
          deviceId: entry.deviceId,
          detached,
          stopped: () => this.queue.stopGeneration(entry.target) !== generation,
          ...(session ? { session } : {}),
          ...(roomMode ? { roomMode } : {}),
        });
      },
      publish: (target) => this.publish(target),
      discard: (entry) => this.discardUploads(entry),
      intervalMs: deps.intervalMs,
      settleMs: deps.settleMs,
      now: deps.now,
    });
  }

  observeViewer(viewerId: string | undefined, deviceId: string | undefined): void {
    if (!viewerId || !deviceId) return;
    if (this.viewers.get(viewerId) === deviceId) return;
    this.viewers.delete(viewerId);
    // Bounded like the other per-socket authority maps.
    if (this.viewers.size >= 256) this.viewers.delete(this.viewers.keys().next().value!);
    this.viewers.set(viewerId, deviceId);
  }

  releaseViewer(viewerId: string): void {
    this.viewers.delete(viewerId);
  }

  /**
   * A persisted room message may mark a turn boundary. It only prompts a
   * re-check: idleness is always read from the RoomManager's own state.
   */
  observeRoomMessage(roomId: string, message: unknown): void {
    const msg = (message ?? {}) as { from?: unknown; type?: unknown };
    if (msg.from !== "user") void this.queue.pump({ kind: "room", roomId });
  }

  /** Pending (including failed/uncertain) turns exist: no permission-mode change. */
  hasPendingTurns(target: MobileTurnQueueTarget): boolean {
    return this.queue.has(target);
  }

  /** Any stop of the current run pauses pending turns until an explicit resume. */
  pauseForStop(target: MobileTurnQueueTarget): void {
    this.queue.pause(target, "stopped");
  }

  /**
   * Admit a queue-capable submission. Returns false when the event must keep
   * its legacy path (no explicit target, no intent id, or no current
   * authority) so the original handler reports the same error it always did.
   */
  async submit(event: AuthenticatedMobileClientEvent): Promise<boolean> {
    if ((event.type !== "chat.send" && event.type !== "room.send") || event.queue !== true)
      return false;
    const viewerId = event.viewerId;
    const deviceId = event.deviceId;
    const clientMessageId = event.clientMessageId?.trim();
    if (!viewerId || !deviceId || !clientMessageId || clientMessageId.length > 200) return false;
    let target: MobileTurnQueueTarget;
    let roomMode: PermissionMode | undefined;
    if (event.type === "chat.send") {
      if (!event.sessionId) return false;
      if (!this.deps.isSessionAuthorized(viewerId, deviceId, event.sessionId)) return false;
      target = { kind: "session", sessionId: event.sessionId };
    } else {
      const room = this.deps.room(event.roomId);
      if (!room || room.observing) return false;
      target = { kind: "room", roomId: event.roomId };
      roomMode = room.mode;
    }
    const identity = fingerprint(event);
    const reject = (message: string): void => {
      this.deps.remote.sendToViewer(
        viewerId,
        event.type === "room.send"
          ? { type: "room.error", roomId: event.roomId, clientMessageId, message }
          : { type: "error", clientMessageId, message },
      );
    };
    const answer = (found: TurnQueueLookup<QueuedTurn>): true => {
      if (found.kind === "conflict") reject(found.message);
      else if (found.kind === "settled") {
        if (found.outcome === "cancelled") reject("这条消息已从队列中取消，没有执行。");
        // A replay of an admitted turn gets its original receipt, never a rerun.
        else
          this.deps.remote.sendToViewer(
            viewerId,
            event.type === "room.send"
              ? { type: "room.accepted", roomId: event.roomId, clientMessageId }
              : { type: "chat.accepted", sessionId: event.sessionId, clientMessageId },
          );
      } else {
        this.deps.remote.sendToViewer(viewerId, {
          type: "chat.queued",
          target,
          clientMessageId,
          entryId: found.entry.id,
          position: found.position,
        });
        this.sendState(viewerId, deviceId, target);
      }
      return true;
    };
    // A replay is answered from its receipt BEFORE any resource is touched: an
    // admitted turn's uploads are already consumed.
    const replay = this.queue.lookup(target, deviceId, clientMessageId, identity);
    if (replay) return answer(replay);
    let session: QueuedSessionAuthority | undefined;
    if (event.type === "chat.send") {
      session = await this.deps.captureSession(viewerId, deviceId, event);
      if (!session) return false;
      const raced = this.queue.lookup(target, deviceId, clientMessageId, identity);
      if (raced) return answer(raced);
    }
    const attachments = event.attachments ?? [];
    const uploadIds = attachments.flatMap((item) =>
      item.transport === "upload" ? [item.uploadId] : [],
    );
    try {
      for (const uploadId of uploadIds) this.deps.uploads?.retain(deviceId, uploadId);
    } catch (error) {
      reject(
        `图片附件已失效，无法加入队列：${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
    const permissionMode = event.type === "chat.send" ? event.permissionMode : roomMode;
    const result = this.queue.enqueue({
      target,
      clientMessageId,
      deviceId,
      viewerId,
      text: typeof event.text === "string" ? event.text.trim() : "",
      attachments: attachments.map(({ clientId, name, mime, size }) => ({
        clientId,
        name,
        mime,
        size,
      })),
      uploadIds,
      ...(permissionMode ? { permissionMode } : {}),
      ...(event.type === "chat.send"
        ? {
            ...(event.modelKey ? { modelKey: event.modelKey } : {}),
            ...(event.nativeConnectionId ? { nativeConnectionId: event.nativeConnectionId } : {}),
          }
        : {}),
      payload: {
        event: { ...event, clientMessageId } as QueueableMobileSend,
        ...(session ? { session } : {}),
        ...(roomMode ? { roomMode } : {}),
      },
      fingerprint: identity,
      transient: true,
    });
    if (result.kind === "rejected") {
      // Nothing was admitted; release only what this request retained.
      for (const uploadId of uploadIds) void this.discard(deviceId, uploadId);
      reject(result.message);
      return true;
    }
    if (result.kind !== "queued") return answer(result);
    const entry = result.entry;
    // Starts synchronously up to its submit await when the target is idle; the
    // original handler then replies with chat.accepted/room.accepted as before.
    void this.queue.pump(target);
    if (entry.status === "dispatching") return true;
    this.queue.reveal(target, entry.id);
    this.deps.remote.sendToViewer(viewerId, {
      type: "chat.queued",
      target,
      clientMessageId,
      entryId: entry.id,
      position: this.queue.entries(target).indexOf(entry),
    });
    return true;
  }

  /** queue.* control events. Returns false for anything else. */
  control(event: AuthenticatedMobileClientEvent): boolean {
    if (!event.type.startsWith("queue.")) return false;
    const control = event as QueueControl;
    const { viewerId, deviceId, target } = control;
    if (!viewerId || !deviceId || !this.deps.remote.hasAuthenticatedViewer(viewerId, deviceId))
      return true;
    if (!this.authorized(viewerId, deviceId, target)) {
      this.deps.remote.sendToViewer(viewerId, {
        type: "queue.error",
        target,
        message: "当前标签页没有这个会话的操作权限。请重新打开该会话。",
      });
      return true;
    }
    let outcome: { ok: true } | { ok: false; message: string } = { ok: true };
    switch (control.type) {
      case "queue.sync":
        this.sendState(viewerId, deviceId, target);
        return true;
      case "queue.cancel":
        outcome = this.queue.cancel(target, control.entryId);
        break;
      case "queue.retry":
        outcome = this.queue.retry(target, control.entryId);
        break;
      case "queue.resume":
        outcome = this.queue.resume(target);
        break;
      case "queue.clear":
        this.queue.clear(target);
        break;
    }
    if (!outcome.ok) {
      this.deps.remote.sendToViewer(viewerId, {
        type: "queue.error",
        target,
        ...("entryId" in control ? { entryId: control.entryId } : {}),
        message: outcome.message,
      });
      // The caller may hold a stale view; reconcile it.
      this.sendState(viewerId, deviceId, target);
    }
    return true;
  }

  /**
   * Stop is the current turn only: pending turns are paused (never dropped)
   * BEFORE the stop reaches its target. The shared run-stop and room-close
   * hooks do the same for Desktop and every other device; this covers a stop
   * that never reaches a live worker.
   */
  before(event: AuthenticatedMobileClientEvent): void {
    if (event.type === "run.stop" && event.sessionId)
      this.pauseForStop({ kind: "session", sessionId: event.sessionId });
    else if (event.type === "room.close") this.pauseForStop({ kind: "room", roomId: event.roomId });
  }

  /** Lifecycle signals observed after the original handler ran. */
  after(event: AuthenticatedMobileClientEvent): void {
    if (event.type === "session.select" && event.viewerId && event.deviceId) {
      // Reconnect/reselect reconciles the visible list, including an empty one.
      this.sendState(event.viewerId, event.deviceId, {
        kind: "session",
        sessionId: event.sessionId,
      });
      void this.queue.pump({ kind: "session", sessionId: event.sessionId });
    }
  }

  dispose(): void {
    this.queue.dispose();
  }

  private isBusy(target: MobileTurnQueueTarget): boolean {
    if (target.kind === "session") return this.deps.isSessionBusy(target.sessionId);
    return this.deps.room(target.roomId)?.busy ?? false;
  }

  private gate(entry: Readonly<TurnQueueEntry<QueuedTurn>>): TurnQueueGate {
    const { remote } = this.deps;
    if (entry.target.kind === "session") {
      // Admission authority is re-verified by the submit path right before it runs.
      if (!entry.payload.session?.viewerBound) return { ok: true };
      const sessionId = entry.target.sessionId;
      const valid = (viewerId: string) =>
        remote.hasAuthenticatedViewer(viewerId, entry.deviceId) &&
        this.deps.isSessionAuthorized(viewerId, entry.deviceId, sessionId);
      if (entry.viewerId && valid(entry.viewerId)) return { ok: true };
      // A reconnected tab of the SAME device may continue; never another device.
      for (const [viewerId, deviceId] of this.viewers)
        if (deviceId === entry.deviceId && valid(viewerId)) return { ok: true, viewerId };
      return { ok: false, message: VIEWER_BOUND_AWAY };
    }
    const room = this.deps.room(entry.target.roomId);
    if (!room) return { ok: false, message: "CLI 会话已不存在。请移除这条排队消息。" };
    if (room.observing) return { ok: false, message: "CLI 会话处于只读观察状态，无法发送。" };
    return { ok: true };
  }

  private authorized(viewerId: string, deviceId: string, target: MobileTurnQueueTarget): boolean {
    if (target.kind === "session")
      return this.deps.isSessionAuthorized(viewerId, deviceId, target.sessionId);
    return this.deps.room(target.roomId) !== undefined;
  }

  private sendState(viewerId: string, deviceId: string, target: MobileTurnQueueTarget): void {
    if (!this.authorized(viewerId, deviceId, target)) return;
    this.deps.remote.sendToViewer(viewerId, {
      type: "queue.state",
      ...this.queue.snapshot(target, deviceId),
    });
  }

  private publish(target: MobileTurnQueueTarget): void {
    if (target.kind === "room") {
      // Room output is already shared with every paired device.
      for (const deviceId of this.deps.remote.onlineDeviceIds())
        this.deps.remote.sendToDevice(deviceId, {
          type: "queue.state",
          ...this.queue.snapshot(target, deviceId),
        });
      return;
    }
    for (const [viewerId, deviceId] of this.viewers) {
      if (!this.deps.remote.hasAuthenticatedViewer(viewerId, deviceId)) continue;
      this.sendState(viewerId, deviceId, target);
    }
  }

  private discardUploads(entry: Readonly<TurnQueueEntry<QueuedTurn>>): void {
    for (const uploadId of entry.uploadIds) void this.discard(entry.deviceId, uploadId);
  }

  private async discard(deviceId: string, uploadId: string): Promise<void> {
    await this.deps.uploads?.discard(deviceId, uploadId).catch(() => undefined);
  }
}
