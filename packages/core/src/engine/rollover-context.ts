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
