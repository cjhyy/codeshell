/**
 * Engine-authored context messages that live in history: the context ledger's
 * snapshots/updates and lifecycle hook reminders. Both are persisted as
 * injected `message` events carrying one of the data fields below, and both
 * are recognised later by which transcript event a Message object stands for —
 * never by reading the message text.
 *
 * The link Message → event is kept outside the Message (a WeakMap) because
 * Message objects are serialized verbatim into provider requests.
 */
import type { Message, TranscriptEvent } from "../types.js";

/** `data.contextLedger` of a ledger event. `state` is a serialized LedgerState. */
export interface ContextLedgerEventData {
  kind: "snapshot" | "update";
  state: string;
  /**
   * A snapshot that revokes every earlier ledger message: the workspace
   * changed, so replay drops them. With empty content it only revokes.
   */
  revokesEarlier?: true;
}

/** `data.hookReminder` of a persisted lifecycle hook reminder. */
export interface HookReminderEventData {
  /**
   * The reminder is appended after the run's user message (which must exist
   * before hooks fire) but belongs just before it; replay moves it there.
   */
  beforeEventId?: string;
  /** Cleaned `on_session_start` messages this reminder carries, if any. */
  sessionStart?: string[];
  /** Cleaned `user_prompt_submit` / `agent_direction_submit` messages, if any. */
  promptSubmit?: string[];
  /**
   * The goal stop hook's verdict that kept the run going ("not met yet").
   * Still engine context for every other reader, but the goal judge reads its
   * own earlier verdicts as part of the conversation it judges.
   */
  goalStopBlock?: true;
}

export type ContextMessageMark =
  | { kind: "ledger"; eventId: string }
  | { kind: "hook-reminder"; eventId: string; reminder: HookReminderEventData };

const marks = new WeakMap<Message, ContextMessageMark>();

export function markContextMessage(message: Message, mark: ContextMessageMark): void {
  marks.set(message, mark);
}

export function contextMessageMark(message: Message): ContextMessageMark | undefined {
  return marks.get(message);
}

/**
 * The conversation the goal judge reads: history without engine context,
 * except the judge's own earlier stop-block verdicts, which stay in place.
 */
export function goalJudgeConversation(messages: readonly Message[]): Message[] {
  return messages.filter((message) => {
    const mark = marks.get(message);
    return (
      mark === undefined || (mark.kind === "hook-reminder" && mark.reminder.goalStopBlock === true)
    );
  });
}

/**
 * True for a hook reminder issued for one specific message, which it directly
 * precedes. It belongs to that message: a span that ends at the message ends
 * before its reminder, in a live list exactly as in a replay.
 */
export function isAnchoredHookReminder(message: Message | undefined): boolean {
  const mark = message && marks.get(message);
  return mark?.kind === "hook-reminder" && mark.reminder.beforeEventId !== undefined;
}

/**
 * History without any engine context (ledger messages and reminders): the
 * conversation itself, for a reader that summarizes or judges what was said.
 */
export function withoutContextMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => !marks.has(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

/** Stored ledger data of an event, or undefined when absent or not understood. */
export function readContextLedgerData(event: TranscriptEvent): ContextLedgerEventData | undefined {
  const raw = event.type === "message" ? event.data.contextLedger : undefined;
  if (!isRecord(raw) || typeof raw.state !== "string") return undefined;
  if (raw.kind !== "snapshot" && raw.kind !== "update") return undefined;
  return {
    kind: raw.kind,
    state: raw.state,
    ...(raw.kind === "snapshot" && raw.revokesEarlier === true ? { revokesEarlier: true } : {}),
  };
}

/**
 * Ledger events replay must leave out: everything before the latest revoking
 * snapshot, and a revoking snapshot without content (it only revokes).
 */
export function revokedLedgerEvents(events: readonly TranscriptEvent[]): Set<TranscriptEvent> {
  const revoked = new Set<TranscriptEvent>();
  let revoking = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const data = readContextLedgerData(event);
    if (!data) continue;
    if (revoking) revoked.add(event);
    else if (data.revokesEarlier) {
      revoking = true;
      if (event.data.content === "") revoked.add(event);
    }
  }
  return revoked;
}

/** Stored hook-reminder data of an event, or undefined when absent or not understood. */
export function readHookReminderData(event: TranscriptEvent): HookReminderEventData | undefined {
  const raw = event.type === "message" ? event.data.hookReminder : undefined;
  if (!isRecord(raw)) return undefined;
  const sessionStart = stringList(raw.sessionStart);
  const promptSubmit = stringList(raw.promptSubmit);
  return {
    ...(typeof raw.beforeEventId === "string" ? { beforeEventId: raw.beforeEventId } : {}),
    ...(sessionStart ? { sessionStart } : {}),
    ...(promptSubmit ? { promptSubmit } : {}),
    ...(raw.goalStopBlock === true ? { goalStopBlock: true as const } : {}),
  };
}

/**
 * True for a transcript event that carries engine context text rather than
 * the conversation: a context-ledger snapshot or update, a hook or in-run
 * reminder, a hook's rewrite of a prompt (`prompt_rewrite`), or a runtime
 * checkpoint containing already-rewritten messages. Takes any
 * value, since remote and export paths read events as untyped JSON.
 *
 * These events stay on local disk — resume replays them so the model sees
 * the same history — but are never sent off the machine or exported: a
 * memory index or a plugin's reminder is not part of the conversation a
 * person shares. See {@link withoutContextEvents}.
 */
export function isContextEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  // Checkpoints are model-only snapshots, not display history. Their message
  // bodies have lost event marks and can contain applied prompt rewrites, so
  // filtering just the top-level message events cannot make them shareable.
  // Original user/assistant events remain in the append-only transcript.
  if (event.type === "prompt_rewrite" || event.type === "context_checkpoint") return true;
  return (
    event.type === "message" &&
    isRecord(event.data) &&
    (event.data.contextLedger !== undefined || event.data.hookReminder !== undefined)
  );
}

/** `events` without engine context ({@link isContextEvent}), for remote clients and exports. */
export function withoutContextEvents<T>(events: readonly T[]): T[] {
  return events.filter((event) => !isContextEvent(event));
}

/**
 * Session state without the fields that hold engine context text
 * (`promptSubmitHookMessages`), for remote clients and exports. Anything
 * else is returned as it is.
 */
export function withoutLocalContextState<T>(state: T): T {
  if (!isRecord(state) || !Object.hasOwn(state, "promptSubmitHookMessages")) return state;
  const { promptSubmitHookMessages: _local, ...shared } = state;
  return shared as T;
}

/**
 * True for a message event that is engine context rather than conversation:
 * it must never be shown, counted or quoted as something a person said.
 */
export function isContextMessageEvent(event: TranscriptEvent): boolean {
  return event.type === "message" && isContextEvent(event);
}

/** Mark `message` as the replay of `event` when the event is a context message. */
export function markReplayedContextMessage(message: Message, event: TranscriptEvent): void {
  if (readContextLedgerData(event)) {
    marks.set(message, { kind: "ledger", eventId: event.id });
    return;
  }
  const reminder = readHookReminderData(event);
  if (reminder) marks.set(message, { kind: "hook-reminder", eventId: event.id, reminder });
}
