/**
 * Engine context across a notes rollover.
 *
 * A rollover replaces the model's history with a checkpoint (the note plus
 * the conversation after the note's boundary). Engine context — ledger
 * messages and reminders — is never part of that checkpoint
 * (context/notes.ts leaves it out): a copy inside a checkpoint would lose its
 * mark and read as something a person said. Instead:
 *
 *   - the context ledger resends one fresh snapshot (run-context-ledger.ts);
 *   - the reminders still in effect are re-attached in front of the
 *     checkpoint, and persisted there, so a replay of the transcript puts
 *     them exactly where the running process has them.
 */
import {
  contextMessageMark,
  markContextMessage,
  type HookReminderEventData,
} from "../session/context-messages.js";
import type { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";

/** Id under which a replay emits message `index` of a checkpoint's snapshot. */
export function checkpointMessageEventId(checkpointEventId: string, index: number): string {
  return `${checkpointEventId}:${index}`;
}

/** The retained messages a checkpoint does not already contain. */
export function withoutCheckpointDuplicates(
  retained: readonly Message[],
  checkpoint: readonly Message[],
): Message[] {
  const inCheckpoint = new Set(checkpoint.map((message) => JSON.stringify(message)));
  return retained.filter((message) => !inCheckpoint.has(JSON.stringify(message)));
}

/**
 * Persist the retained reminders in front of the checkpoint just written.
 * Each one becomes a new reminder event anchored before the checkpoint's
 * first message, and the live message is re-marked as that event. Messages
 * that are not reminders (the user context at the head) are left alone.
 */
export function persistRemindersBeforeCheckpoint(
  transcript: Transcript,
  retained: readonly Message[],
): void {
  const checkpoint = transcript.getEvents("context_checkpoint").at(-1);
  if (!checkpoint) return;
  const beforeEventId = checkpointMessageEventId(checkpoint.id, 0);
  for (const message of retained) {
    const mark = contextMessageMark(message);
    if (mark?.kind !== "hook-reminder" || typeof message.content !== "string") continue;
    const data: HookReminderEventData = { ...mark.reminder, beforeEventId };
    const event = transcript.appendMessage("user", message.content, { hookReminder: data });
    markContextMessage(message, { kind: "hook-reminder", eventId: event.id, reminder: data });
  }
}

/**
 * The id under which a replay emits the message stored as `messageEventId`.
 *
 * Normally that is the event itself. Once a later checkpoint has absorbed the
 * message (a rollover written between a run's user message and its hooks),
 * replay emits it as one of the checkpoint's snapshot messages instead, and a
 * reminder anchored to the original id would no longer find its target. The
 * snapshot position is found by client message id, else by the message being
 * the checkpoint's last one; when neither identifies it the original id is
 * returned and the reminder replays where it was written.
 */
export function replayEventIdOf(transcript: Transcript, messageEventId: string): string {
  const events = transcript.getEvents();
  const index = events.findIndex((event) => event.id === messageEventId);
  if (index < 0) return messageEventId;
  let checkpointIndex = events.length - 1;
  while (checkpointIndex > index && events[checkpointIndex]!.type !== "context_checkpoint") {
    checkpointIndex -= 1;
  }
  if (checkpointIndex <= index) return messageEventId;
  const source = events[index]!;
  const checkpoint = events[checkpointIndex]!;
  const snapshot: unknown = checkpoint.data.messages;
  if (!Array.isArray(snapshot) || snapshot.length === 0) return messageEventId;

  const clientMessageId = source.data.clientMessageId;
  const pairs: unknown = checkpoint.data.clientMessageIds;
  if (typeof clientMessageId === "string" && Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair[0] !== clientMessageId) continue;
      const position: unknown = pair[1];
      if (typeof position === "number" && Number.isInteger(position) && position >= 0) {
        return checkpointMessageEventId(checkpoint.id, position);
      }
    }
  }
  const last = snapshot.at(-1) as Partial<Message> | undefined;
  if (
    last?.role === source.data.role &&
    JSON.stringify(last?.content) === JSON.stringify(source.data.content)
  ) {
    return checkpointMessageEventId(checkpoint.id, snapshot.length - 1);
  }
  return messageEventId;
}
