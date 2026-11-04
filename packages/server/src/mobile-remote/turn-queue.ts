import { randomUUID } from "node:crypto";
import type {
  MobileAttachmentSummary,
  MobileTurnQueueEntry,
  MobileTurnQueueEntryStatus,
  MobileTurnQueueState,
  MobileTurnQueueTarget,
  PermissionMode,
} from "./types.js";

/**
 * Host-owned FIFO of turns submitted while their conversation is busy.
 *
 * The queue never runs anything itself: an entry is handed to the caller's
 * ORIGINAL submit path (same validation, approvals and workspace checks) only
 * when the exact target is idle, so it cannot bypass or duplicate an existing
 * Core/CLI queue. Entries are bound to the conversation they were submitted
 * for, never to a viewer's later selection.
 */

export const MAX_TURN_QUEUE_ENTRIES_PER_TARGET = 20;
export const MAX_TURN_QUEUE_ENTRIES_PER_DEVICE = 50;
export const MAX_TURN_QUEUE_ENTRIES = 200;
/** Remembered admission outcomes so a replayed submission is never run twice. */
const MAX_SETTLED_OUTCOMES = 512;

export type TurnQueueDispatchResult =
  | { ok: true }
  /**
   * requeue: a Stop of the target fenced the turn off before anything was
   * submitted; it returns to the (stopped) queue unchanged, never failed.
   */
  | { ok: false; message: string; uncertain?: boolean; requeue?: boolean };

export type TurnQueueActionResult = { ok: true } | { ok: false; message: string };

export type TurnQueueGate = { ok: true; viewerId?: string } | { ok: false; message: string };

export interface TurnQueueSubmission<P> {
  target: MobileTurnQueueTarget;
  clientMessageId: string;
  deviceId: string;
  viewerId?: string;
  text: string;
  attachments: MobileAttachmentSummary[];
  uploadIds: string[];
  permissionMode?: PermissionMode;
  modelKey?: string;
  nativeConnectionId?: string;
  /** The original validated client event, replayed through its own submit path. */
  payload: P;
  /**
   * Input identity (text + attachment descriptors). A replay of the same intent
   * id with different content is refused rather than mistaken for the same turn.
   */
  fingerprint?: string;
  /**
   * The submitter still awaits a direct acknowledgement (an immediate run on
   * an idle target). Hidden from snapshots and dropped on rejection, so the
   * original submit path's error keeps its legacy meaning. Cleared by reveal().
   */
  transient?: boolean;
}

export interface TurnQueueEntry<P> extends TurnQueueSubmission<P> {
  id: string;
  createdAt: number;
  status: MobileTurnQueueEntryStatus;
  message?: string;
}

export interface MobileTurnQueueDeps<P> {
  /** True while the exact target has an active turn (including its approvals). */
  isBusy(target: MobileTurnQueueTarget): boolean;
  /** Re-check the submitting device's authority immediately before running. */
  canDispatch(entry: Readonly<TurnQueueEntry<P>>): TurnQueueGate;
  dispatch(entry: Readonly<TurnQueueEntry<P>>): Promise<TurnQueueDispatchResult>;
  /** Called after every visible change of one target's queue. */
  publish(target: MobileTurnQueueTarget): void;
  /** Release resources (uploads) of an entry that will never run. */
  discard?(entry: Readonly<TurnQueueEntry<P>>): void;
  now?: () => number;
  /** Poll interval for idle detection; 0 disables the internal timer (tests). */
  intervalMs?: number;
  /** Minimum gap after an accepted dispatch before the next head may run. */
  settleMs?: number;
}

/** A replay's existing outcome, decided before any resource is retained for it. */
export type TurnQueueLookup<P> =
  | { kind: "duplicate"; entry: TurnQueueEntry<P>; position: number }
  | { kind: "settled"; outcome: "dispatched" | "cancelled" }
  | { kind: "conflict"; message: string };

export type TurnQueueEnqueueResult<P> =
  | { kind: "queued"; entry: TurnQueueEntry<P>; position: number }
  | { kind: "duplicate"; entry: TurnQueueEntry<P>; position: number }
  | { kind: "settled"; outcome: "dispatched" | "cancelled" }
  | { kind: "rejected"; message: string };

const INTENT_CONFLICT = "这个消息标识已用于另一条内容，未重复提交。请作为新消息发送。";

interface TargetQueue<P> {
  target: MobileTurnQueueTarget;
  entries: TurnQueueEntry<P>[];
  paused?: MobileTurnQueueState["paused"];
  revision: number;
  lastDispatchAt?: number;
}

export function turnQueueTargetKey(target: MobileTurnQueueTarget): string {
  return target.kind === "session" ? `session:${target.sessionId}` : `room:${target.roomId}`;
}

/** An unknown fingerprint on either side cannot prove a mismatch. */
function sameFingerprint(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

export function sameTurnQueueTarget(
  left: MobileTurnQueueTarget | undefined,
  right: MobileTurnQueueTarget | undefined,
): boolean {
  return !!left && !!right && turnQueueTargetKey(left) === turnQueueTargetKey(right);
}

export class MobileTurnQueue<P> {
  readonly epoch = randomUUID();
  private readonly queues = new Map<string, TargetQueue<P>>();
  private readonly settled = new Map<
    string,
    { outcome: "dispatched" | "cancelled"; fingerprint?: string }
  >();
  private readonly pumping = new Set<string>();
  private readonly stopGenerations = new Map<string, number>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  /** Monotonic across targets so a recreated queue never reuses a revision. */
  private revision = 0;

  constructor(private readonly deps: MobileTurnQueueDeps<P>) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * The live or settled outcome of one device's intent on one target. Callers
   * check this BEFORE retaining resources: a replay of an admitted turn must be
   * answered from its receipt, not re-validated against consumed uploads.
   */
  lookup(
    target: MobileTurnQueueTarget,
    deviceId: string,
    clientMessageId: string,
    fingerprint?: string,
  ): TurnQueueLookup<P> | undefined {
    const key = turnQueueTargetKey(target);
    const queue = this.queues.get(key);
    const position =
      queue?.entries.findIndex(
        (entry) => entry.deviceId === deviceId && entry.clientMessageId === clientMessageId,
      ) ?? -1;
    if (queue && position >= 0) {
      const entry = queue.entries[position]!;
      if (!sameFingerprint(entry.fingerprint, fingerprint))
        return { kind: "conflict", message: INTENT_CONFLICT };
      return { kind: "duplicate", entry, position };
    }
    const settled = this.settled.get(this.identity(deviceId, key, clientMessageId));
    if (!settled) return undefined;
    if (!sameFingerprint(settled.fingerprint, fingerprint))
      return { kind: "conflict", message: INTENT_CONFLICT };
    return { kind: "settled", outcome: settled.outcome };
  }

  /** Admit one submission, or return its existing/settled outcome for a replay. */
  enqueue(submission: TurnQueueSubmission<P>): TurnQueueEnqueueResult<P> {
    if (this.disposed) return { kind: "rejected", message: "排队服务已停止。" };
    const key = turnQueueTargetKey(submission.target);
    const queue = this.queues.get(key);
    const found = this.lookup(
      submission.target,
      submission.deviceId,
      submission.clientMessageId,
      submission.fingerprint,
    );
    if (found?.kind === "conflict") return { kind: "rejected", message: found.message };
    if (found) return found;
    if (!submission.text.trim() && submission.attachments.length === 0)
      return { kind: "rejected", message: "消息必须包含文字或图片。" };
    if ((queue?.entries.length ?? 0) >= MAX_TURN_QUEUE_ENTRIES_PER_TARGET)
      return {
        kind: "rejected",
        message: `每个会话最多排队 ${MAX_TURN_QUEUE_ENTRIES_PER_TARGET} 条消息。`,
      };
    let total = 0;
    let device = 0;
    for (const item of this.queues.values()) {
      total += item.entries.length;
      device += item.entries.filter((entry) => entry.deviceId === submission.deviceId).length;
    }
    if (total >= MAX_TURN_QUEUE_ENTRIES || device >= MAX_TURN_QUEUE_ENTRIES_PER_DEVICE)
      return { kind: "rejected", message: "待执行消息过多，请等待或取消部分排队消息。" };
    const entry: TurnQueueEntry<P> = {
      ...submission,
      attachments: submission.attachments.map((item) => ({ ...item })),
      uploadIds: [...submission.uploadIds],
      id: randomUUID(),
      createdAt: this.now(),
      status: "queued",
    };
    const target = queue ?? { target: submission.target, entries: [], revision: 0 };
    target.entries.push(entry);
    this.queues.set(key, target);
    this.changed(target);
    this.ensureTimer();
    return { kind: "queued", entry, position: target.entries.length - 1 };
  }

  /** Remove one entry that has not been handed to its submit path. */
  cancel(target: MobileTurnQueueTarget, entryId: string): TurnQueueActionResult {
    const queue = this.queues.get(turnQueueTargetKey(target));
    const index = queue?.entries.findIndex((entry) => entry.id === entryId) ?? -1;
    if (!queue || index < 0) return { ok: false, message: "这条排队消息已执行或已移除。" };
    const entry = queue.entries[index]!;
    if (entry.status === "dispatching")
      return { ok: false, message: "这条消息正在提交，无法再取消。可在执行后停止。" };
    queue.entries.splice(index, 1);
    this.retire(entry, "cancelled");
    // The pause belonged to a failed/uncertain entry; once none is left the
    // rest may run. A Stop pause stays until an explicit resume.
    this.releaseFailurePause(queue);
    this.changed(queue);
    void this.pump(target);
    return { ok: true };
  }

  /** Remove every entry that is not already being submitted. */
  clear(target: MobileTurnQueueTarget): number {
    const queue = this.queues.get(turnQueueTargetKey(target));
    if (!queue) return 0;
    const removed = queue.entries.filter((entry) => entry.status !== "dispatching");
    if (!removed.length) return 0;
    queue.entries = queue.entries.filter((entry) => entry.status === "dispatching");
    for (const entry of removed) this.retire(entry, "cancelled");
    queue.paused = undefined;
    this.changed(queue);
    return removed.length;
  }

  /**
   * Stop scheduling after the current turn; nothing is discarded. An explicit
   * Stop outranks a failure/uncertain pause: removing or retrying the entry
   * that caused that pause must not restart the rest. Every Stop advances the
   * target's stop generation, which fences an in-flight dispatch off before it
   * physically submits (see stopGeneration).
   */
  pause(target: MobileTurnQueueTarget, reason: "stopped"): void {
    const key = turnQueueTargetKey(target);
    this.stopGenerations.set(key, this.stopGeneration(target) + 1);
    const queue = this.queues.get(key);
    if (!queue?.entries.length || queue.paused === reason) return;
    queue.paused = reason;
    this.changed(queue);
  }

  /** Monotonic count of Stops of this target during this Host lifetime. */
  stopGeneration(target: MobileTurnQueueTarget): number {
    return this.stopGenerations.get(turnQueueTargetKey(target)) ?? 0;
  }

  /**
   * Continue after Stop or a rejected entry. An entry whose execution cannot
   * be ruled out must be removed first; it is never resubmitted from here.
   */
  resume(target: MobileTurnQueueTarget): TurnQueueActionResult {
    const queue = this.queues.get(turnQueueTargetKey(target));
    if (!queue) return { ok: true };
    if (queue.entries.some((entry) => entry.status === "uncertain"))
      return {
        ok: false,
        message: "有消息无法确认是否已执行。请先核对会话记录，再移除那条消息。",
      };
    for (const entry of queue.entries)
      if (entry.status === "failed") {
        entry.status = "queued";
        entry.message = undefined;
      }
    queue.paused = undefined;
    this.changed(queue);
    void this.pump(target);
    return { ok: true };
  }

  /** Retry a rejected entry with the same clientMessageId. */
  retry(target: MobileTurnQueueTarget, entryId: string): TurnQueueActionResult {
    const queue = this.queues.get(turnQueueTargetKey(target));
    const entry = queue?.entries.find((item) => item.id === entryId);
    if (!queue || !entry) return { ok: false, message: "这条排队消息已执行或已移除。" };
    if (entry.status !== "failed")
      return {
        ok: false,
        message:
          entry.status === "uncertain"
            ? "无法确认这条消息是否已执行，不能自动重试。请核对会话记录。"
            : "这条消息仍在等待，无需重试。",
      };
    entry.status = "queued";
    entry.message = undefined;
    this.releaseFailurePause(queue);
    this.changed(queue);
    void this.pump(target);
    return { ok: true };
  }

  private releaseFailurePause(queue: TargetQueue<P>): void {
    if (
      (queue.paused === "failed" || queue.paused === "uncertain") &&
      !queue.entries.some((entry) => entry.status === "failed" || entry.status === "uncertain")
    )
      queue.paused = undefined;
  }

  /** Publish an entry whose submitter was told it is queued rather than running. */
  reveal(target: MobileTurnQueueTarget, entryId: string): void {
    const queue = this.queues.get(turnQueueTargetKey(target));
    const entry = queue?.entries.find((item) => item.id === entryId);
    if (!queue || !entry?.transient) return;
    entry.transient = undefined;
    this.changed(queue);
  }

  has(target: MobileTurnQueueTarget): boolean {
    return (this.queues.get(turnQueueTargetKey(target))?.entries.length ?? 0) > 0;
  }

  entries(target: MobileTurnQueueTarget): readonly Readonly<TurnQueueEntry<P>>[] {
    return this.queues.get(turnQueueTargetKey(target))?.entries ?? [];
  }

  targets(): MobileTurnQueueTarget[] {
    return [...this.queues.values()].map((queue) => queue.target);
  }

  /** Public state as seen by one recipient device. */
  snapshot(target: MobileTurnQueueTarget, recipientDeviceId?: string): MobileTurnQueueState {
    const queue = this.queues.get(turnQueueTargetKey(target));
    return {
      target,
      epoch: this.epoch,
      revision: queue?.revision ?? this.revision,
      ...(queue?.paused ? { paused: queue.paused } : {}),
      entries: (queue?.entries ?? [])
        .filter((entry) => !entry.transient)
        .map(
          (entry): MobileTurnQueueEntry => ({
            id: entry.id,
            clientMessageId: entry.clientMessageId,
            text: entry.text,
            attachments: entry.attachments.map((item) => ({ ...item })),
            status: entry.status,
            ...(entry.message ? { message: entry.message } : {}),
            createdAt: entry.createdAt,
            ownDevice: recipientDeviceId !== undefined && entry.deviceId === recipientDeviceId,
            ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
            ...(entry.modelKey ? { modelKey: entry.modelKey } : {}),
            ...(entry.nativeConnectionId ? { nativeConnectionId: entry.nativeConnectionId } : {}),
          }),
        ),
    };
  }

  /** Re-evaluate every queue; used by the idle timer and Host lifecycle signals. */
  pumpAll(): Promise<void> {
    return Promise.all(this.targets().map((target) => this.pump(target))).then(() => undefined);
  }

  /**
   * Hand the next runnable entry to its submit path when the exact target is
   * idle. At most one entry per target is in flight. Entries of one device
   * keep their order; a device that cannot run now (e.g. its tab is away)
   * does not hold back other devices' turns. A rejected or uncertain entry
   * pauses the whole target so nothing runs past an unresolved outcome.
   */
  async pump(target: MobileTurnQueueTarget): Promise<void> {
    const key = turnQueueTargetKey(target);
    const queue = this.queues.get(key);
    if (this.disposed || !queue || queue.paused || this.pumping.has(key)) return;
    const settleMs = this.deps.settleMs ?? 750;
    // Give the accepted turn time to register as busy before the next one.
    if (queue.lastDispatchAt !== undefined && this.now() - queue.lastDispatchAt < settleMs) return;
    let busy: boolean;
    try {
      busy = this.deps.isBusy(queue.target);
    } catch {
      busy = true;
    }
    if (busy) return;
    const blocked = new Set<string>();
    let head: TurnQueueEntry<P> | undefined;
    let gate: TurnQueueGate | undefined;
    let waitingChanged = false;
    for (const entry of queue.entries) {
      if (entry.status !== "queued" && entry.status !== "waiting") return;
      if (blocked.has(entry.deviceId)) continue;
      let entryGate: TurnQueueGate;
      try {
        entryGate = this.deps.canDispatch(entry);
      } catch (error) {
        entryGate = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (entryGate.ok) {
        head = entry;
        gate = entryGate;
        break;
      }
      blocked.add(entry.deviceId);
      if (entry.status !== "waiting" || entry.message !== entryGate.message) {
        entry.status = "waiting";
        entry.message = entryGate.message;
        waitingChanged = true;
      }
    }
    if (waitingChanged) this.changed(queue);
    if (!head || !gate?.ok || this.queues.get(key) !== queue) return;
    if (gate.viewerId) head.viewerId = gate.viewerId;
    head.status = "dispatching";
    head.message = undefined;
    this.pumping.add(key);
    this.changed(queue);
    let result: TurnQueueDispatchResult;
    try {
      result = await this.deps.dispatch(head);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pumping.delete(key);
    }
    const index = queue.entries.indexOf(head);
    if (index < 0) return;
    if (result.ok) {
      queue.entries.splice(index, 1);
      queue.lastDispatchAt = this.now();
      this.remember(head, "dispatched");
    } else if (result.requeue) {
      // Fenced off by a Stop before submission: unchanged, waiting for resume.
      head.transient = undefined;
      head.status = "queued";
      head.message = undefined;
    } else if (head.transient && !result.uncertain) {
      // Its submitter received the original definite rejection and still owns
      // the draft; nothing ran.
      queue.entries.splice(index, 1);
    } else {
      // A possibly admitted turn stays visible (even a direct one) so its
      // intent id keeps deduplicating replays; it is never resubmitted.
      head.transient = undefined;
      head.status = result.uncertain ? "uncertain" : "failed";
      head.message = result.message;
      if (queue.paused !== "stopped") queue.paused = result.uncertain ? "uncertain" : "failed";
    }
    if (this.queues.get(key) === queue) this.changed(queue);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const queue of this.queues.values())
      for (const entry of queue.entries) this.deps.discard?.(entry);
    this.queues.clear();
  }

  private identity(deviceId: string, key: string, clientMessageId: string): string {
    return JSON.stringify([deviceId, key, clientMessageId]);
  }

  private retire(entry: TurnQueueEntry<P>, outcome: "cancelled"): void {
    this.remember(entry, outcome);
    try {
      this.deps.discard?.(entry);
    } catch {
      // Upload expiry still reclaims an entry whose release failed.
    }
  }

  private remember(entry: TurnQueueEntry<P>, outcome: "dispatched" | "cancelled"): void {
    const identity = this.identity(
      entry.deviceId,
      turnQueueTargetKey(entry.target),
      entry.clientMessageId,
    );
    this.settled.delete(identity);
    this.settled.set(identity, {
      outcome,
      ...(entry.fingerprint !== undefined ? { fingerprint: entry.fingerprint } : {}),
    });
    while (this.settled.size > MAX_SETTLED_OUTCOMES) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }

  private changed(queue: TargetQueue<P>): void {
    queue.revision = ++this.revision;
    const key = turnQueueTargetKey(queue.target);
    if (!queue.entries.length) {
      // Keep the revision monotonic for clients while an empty state is published.
      this.queues.delete(key);
    }
    try {
      this.deps.publish(queue.target);
    } finally {
      if (!queue.entries.length) this.stopTimerIfIdle();
    }
  }

  private ensureTimer(): void {
    const interval = this.deps.intervalMs ?? 1_000;
    if (this.timer || interval <= 0) return;
    this.timer = setInterval(() => void this.pumpAll(), interval);
    this.timer.unref?.();
  }

  private stopTimerIfIdle(): void {
    if (this.queues.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
