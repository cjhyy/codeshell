import type { ContentBlock, Message, TranscriptEvent, TranscriptEventType } from "../types.js";
import { Transcript, hasCompleteContextToolPairs } from "../session/transcript.js";
import { downgradeImagePayloadsInHistory, estimateTokens } from "./compaction.js";
import { logger } from "../logging/logger.js";

export const MAX_CONTEXT_NOTE_CHARS = 12_000;
export const MAX_CONTEXT_HISTORY_READ_CHARS = 12_000;
export const MAX_CONTEXT_HISTORY_RESULTS = 20;
const HISTORY_SNIPPET_CHARS = 600;
const MODEL_BOUNDARY_EVENT_TYPES = new Set<TranscriptEventType>([
  "message",
  "tool_use",
  "tool_result",
  "summary",
  "context_transfer",
  "range_archive",
  "context_note",
  "context_checkpoint",
]);

export interface ContextHistoryEntry {
  eventId: string;
  type: TranscriptEventType;
  turnNumber: number;
  text: string;
  truncated: boolean;
  untrusted: true;
}

/**
 * One session's continuation notes. The model authors text; this class alone
 * constructs replacement messages and commits them at a completed tool round.
 */
export class SessionContextNotes {
  private modelBoundaryEventId: string | undefined;
  private pendingNoteId: string | undefined;

  constructor(private readonly transcript: Transcript) {}

  /** Keep the normal tool/turn boundary free of replay work when no switch was requested. */
  hasPendingRollover(): boolean {
    return this.pendingNoteId !== undefined;
  }

  /** Call immediately before a model request, before its assistant/tool events. */
  markModelBoundary(): void {
    const events = this.transcript.getEvents();
    // Skip audit-only receipts/metadata: forks intentionally omit those, and
    // they do not represent any additional text the model has consumed.
    const index = findLastEventIndex(events, (event) => MODEL_BOUNDARY_EVENT_TYPES.has(event.type));
    this.modelBoundaryEventId = events[index]?.id;
  }

  save(text: string): string {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("A continuation note must contain non-empty text.");
    }
    if (text.length > MAX_CONTEXT_NOTE_CHARS) {
      throw new Error(`A continuation note must not exceed ${MAX_CONTEXT_NOTE_CHARS} characters.`);
    }
    const cursor = this.modelBoundaryEventId;
    if (!cursor || !this.transcript.getEvents().some((event) => event.id === cursor)) {
      throw new Error("No model context boundary is available for this note.");
    }
    const note = this.transcript.appendContextNote(text, cursor);
    if (!note) throw new Error("The continuation note could not be saved; context was preserved.");
    return note.id;
  }

  /** Queues a switch; the tool call itself must not alter an in-flight batch. */
  requestRollover(): void {
    const events = this.transcript.getEvents();
    const noteIndex = findLastEventIndex(events, (event) => event.type === "context_note");
    const note = events[noteIndex];
    if (!note || !validNote(note)) {
      throw new Error("Save a continuation note before starting a new context.");
    }
    if (events.slice(noteIndex + 1).some((event) => event.type === "context_checkpoint")) {
      throw new Error("This note has already been used. Save a fresh continuation note first.");
    }
    if (this.transcript.flushFailed()) {
      throw new Error("Transcript persistence is unavailable; the current context was preserved.");
    }
    this.pendingNoteId = note.id;
  }

  /**
   * Invoke after all results from the assistant's tool batch have been appended.
   * Every failure consumes the request and leaves the prior replay unchanged.
   */
  applyRollover(
    currentMessages?: readonly Message[],
    retainedMessages: readonly Message[] = [],
  ): Message[] | undefined {
    const noteId = this.pendingNoteId;
    this.pendingNoteId = undefined;
    if (!noteId || this.transcript.flushFailed()) return undefined;
    try {
      return this.commitRollover(noteId, currentMessages, retainedMessages);
    } catch (error) {
      logger.warn("context.notes.rollover_failed", {
        noteId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private commitRollover(
    noteId: string,
    currentMessages?: readonly Message[],
    retainedMessages: readonly Message[] = [],
  ): Message[] | undefined {
    const events = this.transcript.getEvents();
    const noteIndex = events.findIndex((event) => event.id === noteId);
    const note = events[noteIndex];
    if (!note || !validNote(note)) return undefined;
    if (events.slice(noteIndex + 1).some((event) => event.type === "context_checkpoint")) {
      return undefined;
    }
    const cursor = note.data.coveredThroughEventId as string;
    const boundaryIndex = events.findIndex((event) => event.id === cursor);
    if (boundaryIndex < 0 || boundaryIndex >= noteIndex) return undefined;

    const tail = events.slice(boundaryIndex + 1);
    // A misplaced boundary must not silently discard a late result whose
    // opening call was before that boundary. Normal model boundaries never
    // split a batch, but interrupted or corrupt transcripts can do so.
    const tailToolIds = new Set<string>();
    for (const event of tail) {
      if (event.type !== "message" || event.data.role !== "assistant") continue;
      if (!Array.isArray(event.data.content)) continue;
      for (const block of event.data.content as ContentBlock[]) {
        if (block.type === "tool_use" && block.id) tailToolIds.add(block.id);
      }
    }
    if (
      tail.some(
        (event) =>
          event.type === "tool_result" &&
          (typeof event.data.toolCallId !== "string" || !tailToolIds.has(event.data.toolCallId)),
      )
    )
      return undefined;

    const latestUserIndex = findLastEventIndex(events, isRealUserMessage);
    const latestUser = events[latestUserIndex];
    const noteMessage: TranscriptEvent = {
      id: `continuation:${note.id}`,
      type: "message",
      turnNumber: note.turnNumber,
      timestamp: note.timestamp,
      data: {
        role: "user",
        injected: true,
        authority: "agent",
        content:
          "<context-note>\nThe runtime has started a new context in this same session using this note. " +
          "Continue the existing task; do not request another NewContext for this already-used note.\n" +
          "Continuation notes written earlier by the assistant. " +
          "These notes may be incomplete; consult the original session history for details.\n\n" +
          `${note.data.text}\n</context-note>`,
      },
    };
    const rebuilt = Transcript.fromMemoryEvents("context-note-candidate", [
      noteMessage,
      ...(latestUser && latestUserIndex <= boundaryIndex ? [latestUser] : []),
      ...tail,
    ]).toMessagesWithIndex();
    const current = currentMessages ?? this.transcript.toMessages();
    // Carry forward already-budgeted tool outputs from the working context.
    // Replaying raw events must not resurrect a large result or consumed image.
    const liveResults = new Map<string, ContentBlock>();
    for (const message of current) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          liveResults.set(block.tool_use_id, block);
        }
      }
    }
    const snapshotMessages = downgradeImagePayloadsInHistory(
      rebuilt.messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((block) =>
              block.type === "tool_result" &&
              block.tool_use_id &&
              liveResults.has(block.tool_use_id)
                ? structuredClone(liveResults.get(block.tool_use_id)!)
                : block,
            )
          : message.content,
      })),
    ).messages;
    if (!hasCompleteContextToolPairs(snapshotMessages)) return undefined;
    // A stale note, or a prior emergency summary, can make this candidate
    // larger than the live model context. Never replace it in that case.
    if (
      estimateTokens([...retainedMessages, ...snapshotMessages]) >= estimateTokens([...current])
    ) {
      return undefined;
    }
    const checkpoint = this.transcript.appendContextCheckpoint({
      version: 1,
      noteId,
      coveredThroughEventId: cursor,
      messages: snapshotMessages,
      clientMessageIds: [...rebuilt.liveIndexByClientMessageId],
    });
    return checkpoint ? snapshotMessages : undefined;
  }

  search(query: string, limit = 10, beforeEventId?: string): ContextHistoryEntry[] {
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("History search requires a non-empty query.");
    }
    if (query.length > MAX_CONTEXT_HISTORY_READ_CHARS) {
      throw new Error("History search query is too long.");
    }
    const count = Math.min(MAX_CONTEXT_HISTORY_RESULTS, Math.max(1, Math.floor(limit)));
    if (!Number.isFinite(count)) throw new Error("History search limit must be a finite number.");
    const events = this.originalEvents();
    const beforeIndex = beforeEventId
      ? events.findIndex((event) => matchesHistoryEventId(event, beforeEventId))
      : events.length;
    if (beforeIndex < 0) throw new Error("History cursor does not belong to this session.");
    const needle = query.trim().toLocaleLowerCase();
    const entries: ContextHistoryEntry[] = [];
    for (let index = beforeIndex - 1; index >= 0 && entries.length < count; index -= 1) {
      const event = events[index]!;
      const text = historyText(event);
      if (!text) continue;
      const match = text.toLocaleLowerCase().indexOf(needle);
      if (match < 0) continue;
      const start = Math.max(0, match - Math.floor(HISTORY_SNIPPET_CHARS / 3));
      entries.push(historyEntry(event, text, start, HISTORY_SNIPPET_CHARS));
    }
    return entries;
  }

  read(eventId: string): ContextHistoryEntry | undefined {
    const event = this.originalEvents().find((candidate) =>
      matchesHistoryEventId(candidate, eventId),
    );
    if (!event) return undefined;
    const text = historyText(event);
    return text === undefined
      ? undefined
      : historyEntry(event, text, 0, MAX_CONTEXT_HISTORY_READ_CHARS);
  }

  private originalEvents(): TranscriptEvent[] {
    // Active transcripts can be loaded from a bounded tail. Retrieval uses
    // only their own file and never accepts a model-supplied path/session id.
    if (this.transcript.isPersistent()) {
      const stored = Transcript.readEvents(this.transcript.getFilePath()).events;
      const seen = new Set(stored.map((event) => event.id));
      return [...stored, ...this.transcript.getEvents().filter((event) => !seen.has(event.id))];
    }
    return this.transcript.getEvents();
  }
}

function findLastEventIndex(
  events: readonly TranscriptEvent[],
  predicate: (event: TranscriptEvent) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index]!)) return index;
  }
  return -1;
}

function validNote(event: TranscriptEvent): boolean {
  return (
    event.type === "context_note" &&
    Boolean(event.data) &&
    typeof event.data.text === "string" &&
    event.data.text.trim().length > 0 &&
    event.data.text.length <= MAX_CONTEXT_NOTE_CHARS &&
    typeof event.data.coveredThroughEventId === "string"
  );
}

function matchesHistoryEventId(event: TranscriptEvent, eventId: string): boolean {
  return (
    event.id === eventId ||
    (Array.isArray(event.data.contextHistorySourceIds) &&
      event.data.contextHistorySourceIds.includes(eventId))
  );
}

function isRealUserMessage(event: TranscriptEvent): boolean {
  return (
    event.type === "message" &&
    event.data.role === "user" &&
    event.data.injected !== true &&
    (event.data.authority === undefined || event.data.authority === "user")
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: ContentBlock) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return "[image]";
      if (block.type === "tool_use")
        return `${block.name ?? "tool"}: ${JSON.stringify(block.input)}`;
      if (block.type === "tool_result") return contentText(block.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function historyText(event: TranscriptEvent): string | undefined {
  switch (event.type) {
    case "message":
      return contentText(event.data.content);
    case "tool_use":
      return `${event.data.toolName ?? "tool"}: ${JSON.stringify(event.data.args)}`;
    case "tool_result":
      return [event.data.error, event.data.result, contentText(event.data.contentBlocks)]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    case "summary":
    case "context_transfer":
    case "range_archive":
      return typeof event.data.summary === "string" ? event.data.summary : undefined;
    case "context_note":
      return typeof event.data.text === "string" ? event.data.text : undefined;
    default:
      return undefined;
  }
}

function historyEntry(
  event: TranscriptEvent,
  text: string,
  start: number,
  length: number,
): ContextHistoryEntry {
  return {
    eventId: event.id,
    type: event.type,
    turnNumber: event.turnNumber,
    text: text.slice(start, start + length),
    truncated: start > 0 || text.length > length,
    untrusted: true,
  };
}
