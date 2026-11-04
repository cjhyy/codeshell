import type {
  MobileAttachmentSummary,
  MobileTurnQueueState,
  MobileTurnQueueTarget,
} from "@cjhyy/code-shell-core";

/**
 * Client mirror of the Host-owned pending-turn FIFO. The Host is authoritative;
 * this only orders snapshots (epoch + monotonic revision) and remembers which
 * of this tab's queued turns still need a local user bubble once they run.
 */
export type TurnQueueStates = Readonly<Record<string, MobileTurnQueueState>>;

export function turnQueueKey(target: MobileTurnQueueTarget): string {
  return target.kind === "session" ? `session:${target.sessionId}` : `room:${target.roomId}`;
}

/** The queue the composer writes to: a room binding wins over its session. */
export function activeTurnQueueTarget(
  roomId: string | undefined,
  sessionId: string | undefined,
): MobileTurnQueueTarget | undefined {
  if (roomId) return { kind: "room", roomId };
  if (sessionId) return { kind: "session", sessionId };
  return undefined;
}

export interface TurnQueueApplyResult {
  states: TurnQueueStates;
  /**
   * This device's entries a restarted Host (new epoch) no longer lists. A new
   * epoch proves only that the Host's memory was lost: any of them may have
   * run after the last snapshot this tab saw (a "failed" one may have been
   * retried and accepted), so none is reported as not executed.
   */
  lostUnconfirmed: number;
}

/**
 * Apply one Host snapshot. A stale revision from the same Host lifetime is
 * ignored; a new epoch replaces the state and reports this device's entries
 * that disappeared, so the UI can say so instead of hiding it.
 */
export function applyTurnQueueState(
  states: TurnQueueStates,
  incoming: MobileTurnQueueState,
): TurnQueueApplyResult {
  const key = turnQueueKey(incoming.target);
  const previous = states[key];
  if (previous && previous.epoch === incoming.epoch && previous.revision > incoming.revision)
    return { states, lostUnconfirmed: 0 };
  const lostUnconfirmed =
    previous && previous.epoch !== incoming.epoch
      ? previous.entries.filter(
          (entry) =>
            entry.ownDevice &&
            !incoming.entries.some((next) => next.clientMessageId === entry.clientMessageId),
        ).length
      : 0;
  const next = { ...states };
  if (incoming.entries.length) next[key] = incoming;
  // Keep an empty snapshot so an older in-flight revision cannot resurrect entries.
  else next[key] = { ...incoming, entries: [] };
  return { states: next, lostUnconfirmed };
}

/**
 * This device's intent ids the authoritative snapshot proves were admitted
 * and are not of unknown outcome. An "uncertain" entry proves nothing more
 * than the composer already knows, so it does not release that intent.
 */
export function admittedOwnIntents(state: MobileTurnQueueState): string[] {
  return state.entries
    .filter((entry) => entry.ownDevice && entry.status !== "uncertain")
    .map((entry) => entry.clientMessageId);
}

export interface QueuedLocalMessage {
  text: string;
  attachments: MobileAttachmentSummary[] | Array<{ name: string; mime?: string; size: number }>;
  target: MobileTurnQueueTarget;
}

/**
 * Turns this tab queued. A native Session does not echo its user line on the
 * stream, so the bubble is added when the Host's deferred chat.accepted for
 * the same clientMessageId arrives — never at queue time.
 */
export class QueuedLocalMessages {
  private readonly messages = new Map<string, QueuedLocalMessage>();

  remember(clientMessageId: string, message: QueuedLocalMessage): void {
    this.messages.delete(clientMessageId);
    this.messages.set(clientMessageId, message);
    while (this.messages.size > 64) {
      const oldest = this.messages.keys().next().value;
      if (oldest === undefined) break;
      this.messages.delete(oldest);
    }
  }

  take(clientMessageId: string): QueuedLocalMessage | undefined {
    const message = this.messages.get(clientMessageId);
    this.messages.delete(clientMessageId);
    return message;
  }

  /** Forget turns the Host no longer lists (cancelled or cleared). */
  retain(state: MobileTurnQueueState, dispatched: ReadonlySet<string> = new Set()): void {
    const key = turnQueueKey(state.target);
    const present = new Set(state.entries.map((entry) => entry.clientMessageId));
    for (const [id, message] of this.messages)
      if (turnQueueKey(message.target) === key && !present.has(id) && !dispatched.has(id))
        this.messages.delete(id);
  }

  clear(): void {
    this.messages.clear();
  }
}
