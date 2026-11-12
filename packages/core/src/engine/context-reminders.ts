/**
 * Reminders the engine adds to history inside a run: lifecycle hook output
 * (`on_turn_start`, `post_compact`, a stop hook's block reason), turn-limit
 * and context-budget warnings, task and stale-todo nudges.
 *
 * Like every other message the model was sent, a reminder must be in the
 * transcript at the position it was sent from, or the first request after a
 * restart no longer extends the last request of the previous process and the
 * provider's cached prefix is lost. It is stored as an injected message event
 * flagged as a hook reminder with no target (see session/context-messages.ts),
 * so replay emits it where it was written and every consumer that skips
 * engine context — the UI, memory extraction, summaries, the goal judge —
 * skips it too.
 */
import { markContextMessage, type HookReminderEventData } from "../session/context-messages.js";
import type { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";

/** Store `message`, which was just appended to the live history, as engine context. */
export function persistContextReminder(transcript: Transcript, message: Message): void {
  // Reminders are plain text; anything else is not replayable as one.
  if (message.role !== "user" || typeof message.content !== "string") return;
  const data: HookReminderEventData = {};
  const event = transcript.appendMessage("user", message.content, { hookReminder: data }) as
    | ReturnType<Transcript["appendMessage"]>
    | undefined;
  // A sink that stores nothing (a stand-in transcript) leaves it memory-only.
  if (!event) return;
  markContextMessage(message, { kind: "hook-reminder", eventId: event.id, reminder: data });
}
