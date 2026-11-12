/**
 * Run context as append-only history.
 *
 * Providers cache request prefixes, so context that was once sent must stay
 * where it is, byte for byte. A run therefore never replaces the previous
 * run's context: it appends what the model has not been told yet (a full
 * snapshot the first time, item-level updates afterwards, nothing when
 * nothing changed) and persists that message to the transcript, so a session
 * resumed in another process sends the same prefix.
 *
 * What the model "has been told" is the state stored on the latest ledger
 * event — trusted only while the messages it was built from are still in the
 * history about to be sent. Compaction, a notes rollover, an archive or a
 * cleared context can drop them; the next sync then starts a new snapshot.
 */
import {
  parseLedgerState,
  planLedgerEmission,
  serializeLedgerState,
  type ContextSection,
  type LedgerState,
} from "../context/context-ledger.js";
import { wrapHookMessages } from "../hooks/inject.js";
import {
  contextMessageMark,
  markContextMessage,
  readContextLedgerData,
  type HookReminderEventData,
} from "../session/context-messages.js";
import type { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";

/** Whole-text sections the engine adds to the composer's own. */
export function engineContextSections(args: { mcpFailureSummary: string }): ContextSection[] {
  return [{ key: "mcp-failures", text: args.mcpFailureSummary }].filter((section) =>
    Boolean(section.text),
  );
}

/**
 * A profile's "dynamic" runtime context is declared non-durable: it must not
 * reach the transcript and an earlier run's status must not stay visible. It
 * therefore stays out of the ledger and remains a per-run volatile message at
 * the very tail, so removing it next run costs the least cached prefix.
 */
export function runtimeContextMessage(text: string | undefined): Message | null {
  return text ? { role: "user", content: [{ type: "text", text }] } : null;
}

interface LedgerChain {
  state: LedgerState;
  /** The latest snapshot event and every update after it. */
  eventIds: string[];
}

/** The state the transcript says the model was told, with the events it rests on. */
function readLedgerChain(transcript: Transcript): LedgerChain | undefined {
  const events = transcript.getEvents("message");
  let state: LedgerState | undefined;
  const eventIds: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = readContextLedgerData(events[index]!);
    if (!data) continue;
    if (state === undefined) {
      state = parseLedgerState(data.state);
      // An unreadable latest state is no state: start over with a snapshot.
      if (state === undefined) return undefined;
    }
    eventIds.push(events[index]!.id);
    if (data.kind === "snapshot") return { state, eventIds };
  }
  return undefined;
}

export interface RunContextLedger {
  /**
   * Append (and persist) whatever context `messages` does not yet carry.
   * Called at run start and again before each model request, because context
   * management may have dropped the earlier messages in between.
   */
  sync(messages: Message[]): Message | undefined;
}

export function createRunContextLedger(args: {
  transcript: Transcript;
  /** This run's context; fixed for the run, like the message it replaces. */
  sections: readonly ContextSection[];
}): RunContextLedger {
  const { transcript, sections } = args;
  // Only this run appends ledger events while it is active.
  let chain: LedgerChain | undefined;
  let loaded = false;
  return {
    sync(messages) {
      if (!loaded) {
        chain = readLedgerChain(transcript);
        loaded = true;
      }
      const present = new Set<string>();
      for (const message of messages) {
        const mark = contextMessageMark(message);
        if (mark?.kind === "ledger") present.add(mark.eventId);
      }
      const told = chain?.eventIds.every((id) => present.has(id)) ? chain : undefined;
      const emission = planLedgerEmission(sections, told?.state);
      if (emission.kind === "none") return undefined;

      const message: Message = { role: "user", content: emission.text };
      const event = transcript.appendMessage("user", emission.text, {
        contextLedger: { kind: emission.kind, state: serializeLedgerState(emission.state) },
      });
      markContextMessage(message, { kind: "ledger", eventId: event.id });
      messages.push(message);
      chain = {
        state: emission.state,
        eventIds: emission.kind === "update" && told ? [...told.eventIds, event.id] : [event.id],
      };
      return message;
    },
  };
}

/** What the lifecycle hooks returned for this run, by the hook that said it. */
export interface RunHookMessages {
  /** `on_session_start` — fires on every run. */
  sessionStart: string[];
  /** `user_prompt_submit` / `agent_direction_submit`. */
  promptSubmit: string[];
}

export const NO_HOOK_MESSAGES: RunHookMessages = { sessionStart: [], promptSubmit: [] };

type HookSource = "sessionStart" | "promptSubmit";

function cleaned(parts: readonly string[]): string[] {
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function sameParts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/**
 * Put this run's hook reminder just before its user task (the last message),
 * leaving out what history already says: a hook whose output equals its most
 * recent reminder still in `messages` is not repeated. A changed output is
 * appended as a new reminder; the old one stays where it is.
 *
 * Returns the reminders in effect for this run — the new one and the earlier
 * ones it deferred to — which a notes rollover must carry over.
 */
export function injectHookReminder(args: {
  messages: Message[];
  transcript: Transcript;
  hooks: RunHookMessages;
  /** Transcript id of the run's user message; replay puts the reminder before it. */
  userMessageEventId: string;
}): Message[] {
  const { messages } = args;
  const inEffect: Message[] = [];
  const fresh: HookReminderEventData = {};
  for (const source of ["sessionStart", "promptSubmit"] as const satisfies HookSource[]) {
    const parts = cleaned(args.hooks[source]);
    if (parts.length === 0) continue;
    let latest: Message | undefined;
    for (let index = messages.length - 1; index >= 0 && !latest; index -= 1) {
      const mark = contextMessageMark(messages[index]!);
      if (mark?.kind === "hook-reminder" && mark.reminder[source]) latest = messages[index];
    }
    const mark = latest && contextMessageMark(latest);
    if (latest && mark?.kind === "hook-reminder" && sameParts(mark.reminder[source]!, parts)) {
      if (!inEffect.includes(latest)) inEffect.push(latest);
    } else {
      fresh[source] = parts;
    }
  }
  const reminder = wrapHookMessages([...(fresh.sessionStart ?? []), ...(fresh.promptSubmit ?? [])]);
  if (!reminder) return inEffect;

  const data: HookReminderEventData = { beforeEventId: args.userMessageEventId, ...fresh };
  const event = args.transcript.appendMessage("user", reminder.content, { hookReminder: data });
  markContextMessage(reminder, { kind: "hook-reminder", eventId: event.id, reminder: data });
  // messages[length - 1] is the user task: CLAUDE.md → reminder → user request.
  messages.splice(messages.length - 1, 0, reminder);
  return [...inEffect, reminder];
}

/**
 * Lay out a run's message list around the history it resumed: the user
 * context at the head, the hook reminder before the user task, the context
 * ledger's snapshot or update after it, and a non-durable runtime context
 * message (if the profile has one) last. Mutates `messages`.
 *
 * Returns `retained`, the messages a notes rollover must re-attach
 * (instructions and the hook reminders in effect; ledger messages are not
 * among them: after any rewrite that drops them, the next
 * {@link RunContextLedger.sync} resends), and `runStartMessage`, the first
 * message this run added to the resumed history — the hook reminder it put
 * before the user task, else the user task. Everything before it is settled
 * history (engine/stable-prefix.ts).
 */
export function assembleRunMessages(args: {
  messages: Message[];
  transcript: Transcript;
  userMessageEventId: string;
  userContextMsg: Message | null;
  hooks: RunHookMessages;
  ledger: RunContextLedger;
  volatileContextMsg: Message | null;
}): { retained: Message[]; runStartMessage: Message | undefined } {
  // The user task is the last message; everything before it is resumed history.
  const historyCount = args.messages.length - 1;
  const reminders = injectHookReminder(args);
  const runStartMessage = args.messages[historyCount];
  // Prepend userContext (CLAUDE.md) as first message (sync, fast)
  if (args.userContextMsg) args.messages.unshift(args.userContextMsg);
  args.ledger.sync(args.messages);
  if (args.volatileContextMsg) args.messages.push(args.volatileContextMsg);
  return {
    retained: [...(args.userContextMsg ? [args.userContextMsg] : []), ...reminders],
    runStartMessage,
  };
}
