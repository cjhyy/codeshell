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
 * History without the context ledger's messages, for a reader that judges the
 * conversation itself (they are the engine's framing, not something said).
 */
export function withoutLedgerMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => marks.get(message)?.kind !== "ledger");
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
  return { kind: raw.kind, state: raw.state };
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
  };
}

/**
 * True for a message event that is engine context rather than conversation:
 * it must never be shown, counted or quoted as something a person said.
 */
export function isContextMessageEvent(event: TranscriptEvent): boolean {
  return (
    event.type === "message" &&
    (event.data.contextLedger !== undefined || event.data.hookReminder !== undefined)
  );
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
