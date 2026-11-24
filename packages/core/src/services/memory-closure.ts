/**
 * Memory closure — when a work segment's memories are extracted, and from what.
 *
 * The memory pipeline used to run after every Engine run and re-read the whole
 * transcript window each time. A closure runs once per work segment instead:
 * it reads only what was said after the previous closure (a cursor kept in the
 * session state), and only when a person typed something in that stretch.
 *
 * The window is cut from the transcript's raw events, not from the model
 * replay: raw events are append-only and keep their ids, while a replay swaps
 * compacted history for synthetic messages and would lose the cursor.
 *
 * Everything here reads structured event fields. Nothing parses message text.
 */
import type { ContentBlock, TranscriptEvent } from "../types.js";
import { isContextMessageEvent, isDisplayOnlyMessageEvent } from "../session/context-messages.js";
import { Transcript } from "../session/transcript.js";
import { sanitizeContent } from "../logging/sanitize-messages.js";
import type { MemoryTranscriptMessage } from "./memory-transcript.js";

/** How far a session's conversation has been read for memories. */
export interface MemoryCursor {
  v: 1;
  /** Last transcript event the previous closure covered. */
  eventId: string;
  /** That event's timestamp: the anchor when the id is not in view (tail load, fork). */
  at: number;
  closedAt: number;
}

export interface ClosureMessage {
  role: string;
  content: string | ContentBlock[];
}

export interface ClosureWindow {
  /** Conversation messages after the cursor, oldest first. */
  fresh: ClosureMessage[];
  /** The last few covered messages that carry text, for reference only. */
  context: ClosureMessage[];
  /** New user messages a person typed. */
  humanCount: number;
  /** How the cursor was located in these events. */
  anchor: "none" | "event" | "timestamp";
  /** Where the cursor goes once this window has been processed. */
  through?: { eventId: string; at: number };
}

export type ClosureDecision =
  | { run: true }
  | { run: false; reason: "no-new-messages" | "no-human-message" | "too-short" };

/**
 * How long a long-lived host lets a session stay quiet before closing its work
 * segment. The same span Mimi uses to tell segments apart; it is not sensitive,
 * because a closure the timer misses happens when the session next runs.
 */
export const MEMORY_CLOSURE_IDLE_MS = 30 * 60 * 1000;

/** A session's first closure needs this many conversation messages. */
export const FIRST_CLOSURE_MIN_MESSAGES = 8;
const CONTEXT_MESSAGES = 4;
const CONTEXT_MESSAGE_CHARS = 600;
const CONTEXT_NOTE =
  "Earlier messages, already covered by a previous pass. They are shown only so the " +
  "messages below make sense: do not extract memories from them.";

/**
 * What a closure reads. Summaries, handoffs and range archives are left out:
 * they restate content from elsewhere instead of adding to the conversation.
 */
const CLOSURE_EVENT_TYPES: ReadonlySet<TranscriptEvent["type"]> = new Set([
  "message",
  "tool_result",
  "prompt_rewrite",
]);

function isConversationEvent(event: TranscriptEvent): boolean {
  return (
    CLOSURE_EVENT_TYPES.has(event.type) &&
    !isContextMessageEvent(event) &&
    !isDisplayOnlyMessageEvent(event)
  );
}

function isConversationRole(message: { role?: unknown }): boolean {
  return message.role === "user" || message.role === "assistant";
}

/** A user message a person typed, decided by event fields and never by its text. */
export function isHumanAuthoredEvent(event: TranscriptEvent): boolean {
  if (event.type !== "message") return false;
  const { role, injected, displayOnly, authority, source } = event.data;
  return (
    role === "user" &&
    injected !== true &&
    displayOnly !== true &&
    (authority === undefined || authority === "user") &&
    source === undefined
  );
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function locate(
  events: readonly TranscriptEvent[],
  cursor: MemoryCursor | undefined,
): { index: number; anchor: ClosureWindow["anchor"] } {
  if (!cursor) return { index: -1, anchor: "none" };
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.id === cursor.eventId) return { index, anchor: "event" };
  }
  // The id is not in this view: the transcript was loaded from its tail, or a
  // fork gave the copied events new ids. Timestamps survive both.
  let index = -1;
  for (let position = 0; position < events.length; position++) {
    if (events[position]!.timestamp <= cursor.at) index = position;
  }
  return { index, anchor: "timestamp" };
}

/** Split a transcript's events into what a closure still has to read and its lead-in. */
export function selectClosureWindow(
  events: readonly TranscriptEvent[],
  cursor: MemoryCursor | undefined,
): ClosureWindow {
  const { index, anchor } = locate(events, cursor);
  const freshEvents = events.slice(index + 1).filter(isConversationEvent);
  const contextEvents: TranscriptEvent[] = [];
  for (let position = index; position >= 0 && contextEvents.length < CONTEXT_MESSAGES; position--) {
    const event = events[position]!;
    if (
      event.type === "message" &&
      isConversationEvent(event) &&
      isConversationRole(event.data) &&
      textOf(event.data.content).trim() !== ""
    ) {
      contextEvents.unshift(event);
    }
  }
  const last = events.at(-1);
  return {
    fresh: Transcript.eventsToMessages(freshEvents).filter(isConversationRole),
    context: Transcript.eventsToMessages(contextEvents),
    humanCount: freshEvents.filter(isHumanAuthoredEvent).length,
    anchor,
    ...(last ? { through: { eventId: last.id, at: last.timestamp } } : {}),
  };
}

/** Whether a window is worth a model call. A skipped window keeps its cursor. */
export function closureGate(
  window: Pick<ClosureWindow, "fresh" | "humanCount">,
  cursor: MemoryCursor | undefined,
): ClosureDecision {
  if (window.fresh.length === 0) return { run: false, reason: "no-new-messages" };
  if (window.humanCount === 0) return { run: false, reason: "no-human-message" };
  if (!cursor && window.fresh.length < FIRST_CLOSURE_MIN_MESSAGES) {
    return { run: false, reason: "too-short" };
  }
  return { run: true };
}

/** The covered lead-in as one transcript entry, or nothing when there is none. */
export function renderClosureContext(context: readonly ClosureMessage[]): string | undefined {
  if (context.length === 0) return undefined;
  const lines = context.map(({ role, content }) => {
    const text = textOf(content).replace(/\s+/g, " ").trim();
    const shown =
      text.length > CONTEXT_MESSAGE_CHARS ? `${text.slice(0, CONTEXT_MESSAGE_CHARS)}…` : text;
    return `- ${role}: ${shown}`;
  });
  return [CONTEXT_NOTE, ...lines].join("\n");
}

/** A conversation message as the memory prompts take it: sanitized, flattened text. */
export function toMemoryTranscriptMessage(message: ClosureMessage): MemoryTranscriptMessage {
  const safe = sanitizeContent(message.content);
  return {
    role: message.role,
    content: typeof safe === "string" ? safe : JSON.stringify(safe),
    // A turn ends on an assistant message without tool calls; the memory
    // prompts seal a cache piece there (memory-transcript.ts).
    endsTurn:
      message.role === "assistant" &&
      (typeof message.content === "string" ||
        !message.content.some((block) => block.type === "tool_use")),
  };
}

/** A window as the transcript a memory prompt renders: the covered lead-in, then what is new. */
export function closureTranscript(
  window: Pick<ClosureWindow, "fresh" | "context">,
): MemoryTranscriptMessage[] {
  const context = renderClosureContext(window.context);
  return [
    // One leading entry, not a user or assistant turn: nothing that reads the
    // conversation by role mistakes covered messages for new ones.
    ...(context ? [toMemoryTranscriptMessage({ role: "context", content: context })] : []),
    ...window.fresh.map(toMemoryTranscriptMessage),
  ];
}

export type MemoryClosurePlan =
  | { run: true; window: ClosureWindow; transcript: MemoryTranscriptMessage[] }
  | {
      run: false;
      window: ClosureWindow;
      reason: Exclude<ClosureDecision, { run: true }>["reason"];
    };

/**
 * Everything a host needs to close a work segment: the transcript to extract
 * from, or the reason to leave the stretch (and the cursor) alone. The Engine
 * and Desktop's external runtime both close segments through this.
 */
export function planMemoryClosure(
  events: readonly TranscriptEvent[],
  cursor: MemoryCursor | undefined,
): MemoryClosurePlan {
  const window = selectClosureWindow(events, cursor);
  const decision = closureGate(window, cursor);
  return decision.run
    ? { run: true, window, transcript: closureTranscript(window) }
    : { run: false, window, reason: decision.reason };
}

type ClosureTask = () => Promise<void>;

/**
 * Decides when a session's closure runs: after the session has been quiet for
 * `idleMs`, at most one at a time per session. Timers are in-process and
 * best-effort; a closure lost to a restart is picked up when the session runs
 * again (the cursor is still behind).
 */
export class MemoryClosureScheduler {
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(
    private readonly options: {
      idleMs: number;
      onError?: (sessionId: string, error: unknown) => void;
    },
  ) {}

  get idleMs(): number {
    return this.options.idleMs;
  }

  /** A run ended: start (or restart) the quiet period. The latest task wins. */
  schedule(sessionId: string, task: ClosureTask): void {
    if (this.disposed) return;
    this.cancel(sessionId);
    const timer = setTimeout(() => {
      if (this.waiting.get(sessionId) !== timer) return;
      this.waiting.delete(sessionId);
      this.start(sessionId, task);
    }, this.options.idleMs);
    timer.unref?.();
    this.waiting.set(sessionId, timer);
  }

  /** Run now, unless a closure is already waiting or running for the session. */
  runNow(sessionId: string, task: ClosureTask): boolean {
    if (this.disposed || this.hasPending(sessionId)) return false;
    this.start(sessionId, task);
    return true;
  }

  /** Waiting or running. */
  hasPending(sessionId: string): boolean {
    return this.waiting.has(sessionId) || this.running.has(sessionId);
  }

  /**
   * Drop the waiting closure: a new run continues the segment, or the session
   * closed. One that is already running finishes on its frozen snapshot.
   */
  cancel(sessionId: string): void {
    const timer = this.waiting.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.waiting.delete(sessionId);
  }

  /** Resolves once nothing is running for the session. */
  idle(sessionId: string): Promise<void> {
    return this.running.get(sessionId) ?? Promise.resolve();
  }

  /** Drop everything that is waiting and refuse new work. */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.waiting.keys()]) this.cancel(sessionId);
  }

  private start(sessionId: string, task: ClosureTask): void {
    const previous = this.running.get(sessionId) ?? Promise.resolve();
    const done: Promise<void> = previous
      .then(() => (this.disposed ? undefined : task()))
      .catch((error) => this.options.onError?.(sessionId, error))
      .finally(() => {
        if (this.running.get(sessionId) === done) this.running.delete(sessionId);
      });
    this.running.set(sessionId, done);
  }
}
