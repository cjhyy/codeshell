/**
 * Transcript — JSONL event log (NOT chat history).
 * toMessages() derives Message[] from events for sending to LLM.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { TranscriptEvent, TranscriptEventType, Message, ContentBlock } from "../types.js";
import type { EngineResult } from "../engine/types.js";
import { logger } from "../logging/logger.js";

type TranscriptWriter = (filePath: string, data: string, encoding: "utf-8") => void;

type ParsedEvents = { events: TranscriptEvent[]; malformedLineCount: number };

function appendTranscriptLine(filePath: string, data: string): void {
  // Use one append-mode descriptor so concurrent OS writers cannot overwrite
  // one another. Also repair the record boundary after a crash-torn final line;
  // otherwise the next valid event is concatenated to the fragment and both
  // are discarded on replay.
  const fd = openSync(filePath, "a+", 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const size = fstatSync(fd).size;
    let prefix = "";
    if (size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      readSync(fd, lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 0x0a) prefix = "\n";
    }
    appendFileSync(fd, prefix + data, "utf-8");
  } finally {
    closeSync(fd);
  }
}

const defaultTranscriptWriter: TranscriptWriter = (filePath, data) => {
  appendTranscriptLine(filePath, data);
};

export interface TranscriptFlushFailure {
  errno: string | number;
  code?: string;
  message: string;
  timestamp: number;
  attempts: 2;
  recoverable: false;
  filePath: string;
}

export interface ContextEventRange {
  fromEventId: string;
  toEventId: string;
}

export interface SelectedContextRange {
  events: TranscriptEvent[];
  messages: Message[];
  sourceEventCount: number;
}

export type SummaryAppendMetadata =
  | { fromTurn: number; toTurn: number; eventCount: number }
  | {
      trigger: "context_transfer";
      sourceRange: {
        sessionId: string;
        fromEventId: string;
        toEventId: string;
      };
      sourceEventCount: number;
      estimatedTokens: number;
      summaryVersion: number;
      summaryHash: string;
    };

const CONTEXT_EVENT_TYPES: ReadonlySet<TranscriptEventType> = new Set([
  "message",
  "tool_use",
  "tool_result",
  "summary",
  "context_transfer",
  "range_archive",
]);

const INTERRUPTED_TOOL_RESULT_ERROR = "[Tool result missing due to interrupted session]";

function isSyntheticInterruptedToolResult(event: TranscriptEvent): boolean {
  return (
    event.type === "tool_result" &&
    event.data.toolName === "unknown" &&
    event.data.error === INTERRUPTED_TOOL_RESULT_ERROR
  );
}

/**
 * Choose at most one result for every declared tool call. A real late result
 * wins over the legacy synthetic "interrupted" placeholder that an older
 * reader could persist while the tool was merely waiting for approval.
 */
function preferredToolResults(events: readonly TranscriptEvent[]): Map<string, TranscriptEvent> {
  const toolUseIds = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_use" && typeof event.data.toolCallId === "string") {
      toolUseIds.add(event.data.toolCallId);
    }
    if (
      event.type === "message" &&
      event.data.role === "assistant" &&
      Array.isArray(event.data.content)
    ) {
      for (const block of event.data.content as ContentBlock[]) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          toolUseIds.add(block.id);
        }
      }
    }
  }

  const preferred = new Map<string, TranscriptEvent>();
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const toolCallId = event.data.toolCallId;
    if (typeof toolCallId !== "string" || !toolUseIds.has(toolCallId)) continue;
    const current = preferred.get(toolCallId);
    if (
      !current ||
      isSyntheticInterruptedToolResult(current) ||
      !isSyntheticInterruptedToolResult(event)
    ) {
      preferred.set(toolCallId, event);
    }
  }
  return preferred;
}

export class Transcript {
  private events: TranscriptEvent[] = [];
  private filePath: string;
  private currentTurn = 0;
  private readonly writer: TranscriptWriter;
  private readonly persistent: boolean;
  private dirty = false;
  private lastFlushFailure: TranscriptFlushFailure | undefined;

  getFilePath(): string {
    return this.filePath;
  }

  constructor(
    filePath: string,
    writer: TranscriptWriter = defaultTranscriptWriter,
    options: { persistent?: boolean } = {},
  ) {
    this.filePath = filePath;
    this.writer = writer;
    this.persistent = options.persistent !== false;
    if (!this.persistent) return;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "", { encoding: "utf-8", mode: 0o600 });
    } else if (process.platform !== "win32") {
      // Tighten transcripts created by older releases on first use.
      chmodSync(filePath, 0o600);
    }
  }

  /** A process-local transcript that never creates or appends a file. */
  static inMemory(label: string): Transcript {
    return new Transcript(`<memory:${label}>`, () => undefined, { persistent: false });
  }

  /** Rehydrate a process-local fork without serializing its copied history. */
  static fromMemoryEvents(label: string, events: readonly TranscriptEvent[]): Transcript {
    const transcript = Transcript.inMemory(label);
    transcript.loadEvents(events);
    return transcript;
  }

  isPersistent(): boolean {
    return this.persistent;
  }

  append(type: TranscriptEventType, data: Record<string, unknown>): TranscriptEvent {
    const event: TranscriptEvent = {
      id: nanoid(12),
      type,
      timestamp: Date.now(),
      turnNumber: this.currentTurn,
      data,
    };
    this.events.push(event);
    this.flush(event);
    return event;
  }

  /**
   * Append a chat message to the transcript.
   *
   * `injected` marks a synthetic system-reminder turn (e.g. a background-job
   * completion notification) that is submitted to the model as `role:"user"`
   * but is NOT the user's own input. The disk reader uses this flag to skip
   * rendering it as a user bubble on replay (matching the live UI, which never
   * shows it as a bubble — only the assistant's reply). Real user input and
   * step-gap steering messages are left unmarked so they render normally.
   */
  appendMessage(
    role: string,
    content: string | ContentBlock[],
    opts?: {
      injected?: boolean;
      steerId?: string;
      clientMessageId?: string;
      displayText?: string;
      authority?: "user" | "agent" | "system" | "policy";
      source?: "agent-direction" | "goal-control";
      envelopeIds?: string[];
      correlationIds?: string[];
    },
  ): TranscriptEvent {
    if (opts?.clientMessageId) {
      const existing = this.findMessageByClientId(opts.clientMessageId);
      if (existing) {
        logger.info("steer.submit.duplicate_ignored", {
          clientMessageId: opts.clientMessageId,
          role,
          transcript: this.filePath,
        });
        return existing;
      }
    }
    return this.append("message", {
      role,
      content,
      ...(opts?.injected ? { injected: true } : {}),
      ...(opts?.steerId ? { steerId: opts.steerId } : {}),
      ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
      ...(opts?.displayText ? { displayText: opts.displayText } : {}),
      ...(opts?.authority ? { authority: opts.authority } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
      ...(opts?.envelopeIds ? { envelopeIds: opts.envelopeIds } : {}),
      ...(opts?.correlationIds ? { correlationIds: opts.correlationIds } : {}),
    });
  }

  hasClientMessageId(clientMessageId: string): boolean {
    return this.findMessageByClientId(clientMessageId) !== undefined;
  }

  /**
   * Persist the exact response associated with one idempotent submit. The
   * receipt stays outside toMessages(), so replay support does not change the
   * model's conversation history.
   */
  appendRunResult(clientMessageId: string, result: EngineResult): TranscriptEvent {
    return this.append("run_result", { clientMessageId, result });
  }

  /** Return the newest valid durable response for an idempotent submit. */
  findRunResultByClientMessageId(clientMessageId: string): EngineResult | undefined {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]!;
      if (event.type !== "run_result" || event.data.clientMessageId !== clientMessageId) continue;
      const result = event.data.result;
      if (!isEngineResultReceipt(result)) return undefined;
      return result;
    }
    return undefined;
  }

  appendToolUse(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): TranscriptEvent {
    return this.append("tool_use", { toolName, toolCallId, args });
  }

  appendToolResult(
    toolCallId: string,
    toolName: string,
    result?: string,
    error?: string,
    contentBlocks?: ContentBlock[],
  ): TranscriptEvent {
    return this.append("tool_result", {
      toolCallId,
      toolName,
      result,
      error,
      ...(contentBlocks && contentBlocks.length > 0 ? { contentBlocks } : {}),
    });
  }

  /** Anchor for a spawned sub-agent (see TranscriptEventType "subagent").
   *  Written at spawn time so replay can rebuild the sub-agent's card from
   *  sessions/<agentId>/ — agentId === the sub-agent's session id. */
  appendSubagent(agentId: string, name: string | undefined, description: string): TranscriptEvent {
    return this.append("subagent", { agentId, name, description });
  }

  appendTurnBoundary(): TranscriptEvent {
    this.currentTurn++;
    return this.append("turn_boundary", { turnNumber: this.currentTurn });
  }

  /**
   * Mark the in-flight turn as user-interrupted (Stop). Persisted so a resume
   * rebuilds the renderer's "stopped" marker (foldTranscript) — otherwise the
   * interrupted turn folds behind the process-card header on reload.
   * Idempotent: a no-op if the last event is already a turn_stopped (the loop
   * can hit more than one abort return for a single Stop).
   */
  appendTurnStopped(): TranscriptEvent | undefined {
    const last = this.events[this.events.length - 1];
    if (last && last.type === "turn_stopped") return undefined;
    return this.append("turn_stopped", {});
  }

  appendSummary(summary: string, metadata: SummaryAppendMetadata): TranscriptEvent {
    if ("trigger" in metadata) {
      const { trigger: _trigger, ...provenance } = metadata;
      return this.append("context_transfer", { summary, ...provenance });
    }
    return this.append("summary", {
      summary,
      trigger: "auto",
      compactedRange: metadata,
      preservedSegment: {
        headEventId: this.events[0]?.id,
        tailEventId: this.events[this.events.length - 1]?.id,
      },
    });
  }

  /**
   * Persist a range-archival boundary. Span is [fromClientMessageId,
   * toClientMessageId) over message events; an absent from means "from the
   * beginning". Idempotent on segmentId so a crash-replayed closure cannot
   * double-archive.
   */
  appendRangeArchive(data: {
    summary: string;
    toClientMessageId: string;
    fromClientMessageId?: string;
    segmentId?: string;
  }): TranscriptEvent | undefined {
    if (
      data.segmentId &&
      this.events.some((e) => e.type === "range_archive" && e.data.segmentId === data.segmentId)
    ) {
      return undefined;
    }
    return this.append("range_archive", { ...data });
  }

  appendError(error: string, details?: Record<string, unknown>): TranscriptEvent {
    return this.append("error", { error, ...details });
  }

  /**
   * Derive Message[] from transcript events for sending to the LLM.
   * This is the critical boundary: the LLM never sees the event log directly.
   */
  toMessages(): Message[] {
    return this.toMessagesWithIndex().messages;
  }

  /**
   * Marker-aware replay that ALSO reports, for every emitted message event
   * carrying a clientMessageId, the LIVE index (its position in the returned
   * messages array) of its FIRST emission. This is how the engine resolves an
   * anchored archival window: raw transcript indices grow forever and go stale
   * the moment a range_archive marker trims the replay, so any caller-held
   * index range is meaningless — only client-message-id anchors resolved over
   * THIS replay identify the right span.
   *
   * Contract details:
   * - Messages dropped inside an archived span get NO index entry — they are
   *   not in the live list, so a window anchored on them cannot be built
   *   (the engine fails open in that case).
   * - Only the FIRST emission of a duplicated clientMessageId is recorded
   *   (duplicates replay as plain messages per the one-shot span rule; the
   *   first index is the meaningful one).
   * - The clientMessageId is deliberately NOT attached to the Message objects
   *   themselves: Message[] is exactly what gets serialized into LLM request
   *   payloads, and transport metadata must not leak into them.
   */
  toMessagesWithIndex(): {
    messages: Message[];
    liveIndexByClientMessageId: Map<string, number>;
  } {
    const messages: Message[] = [];
    const liveIndexByClientMessageId = new Map<string, number>();
    const selectedToolResults = preferredToolResults(this.events);
    const hasRangeArchive = this.events.some((e) => e.type === "range_archive");

    // Range-archive pre-pass: collect valid markers keyed by their span-opening
    // client message id. A marker whose to-anchor no longer resolves to a
    // message event is ignored (fail open to full history rather than
    // swallowing the tail of the conversation). Skipped entirely for the
    // (common) case of a session with no archive markers at all, so the
    // resume hot path for non-Mimi sessions does not pay for two extra scans.
    interface ArchiveSpan {
      summary: string;
      toClientMessageId: string;
    }
    const spansByFromId = new Map<string, ArchiveSpan>();
    let openingSpan: ArchiveSpan | undefined;
    if (hasRangeArchive) {
      // First-occurrence event index per client message id, so a marker whose
      // `to` does not come strictly after its `from` (out of order, or a
      // degenerate from === to) can be rejected. Without this check the span
      // opens at `from` but its close condition (`to`) was already passed
      // while scanning forward, so it would never close — silently swallowing
      // the rest of the conversation. Fail open instead: ignore the marker.
      const firstIndexByClientId = new Map<string, number>();
      for (const [index, event] of this.events.entries()) {
        if (event.type === "message" && typeof event.data.clientMessageId === "string") {
          if (!firstIndexByClientId.has(event.data.clientMessageId)) {
            firstIndexByClientId.set(event.data.clientMessageId, index);
          }
        }
      }
      const presentClientIds = new Set(firstIndexByClientId.keys());
      for (const event of this.events) {
        if (event.type !== "range_archive") continue;
        const { summary, toClientMessageId, fromClientMessageId } = event.data as {
          summary: string;
          toClientMessageId: string;
          fromClientMessageId?: string;
        };
        if (typeof summary !== "string" || !presentClientIds.has(toClientMessageId)) continue;
        if (fromClientMessageId === undefined) {
          // Multiple from-less markers compete for this single opening-span
          // slot; the LAST one wins (matching spansByFromId's Map.set
          // semantics below). Last-wins is CORRECT by construction, not
          // merely a tiebreak: the engine resolves a from-less archival
          // window as [0, to) over the LIVE replay, so the window that
          // produced a LATER from-less marker began with the EARLIER
          // marker's replayed summary message, and summarizeRange merge-fed
          // that prior summary (extractAnchoredSummary) into the new one.
          // The later summary therefore already contains the earlier one's
          // content — dropping the earlier marker here loses nothing. (And
          // in production from-less windows only advance: each new marker
          // ends at a later boundary, so the surviving span is the widest.)
          openingSpan = { summary, toClientMessageId };
        } else if (presentClientIds.has(fromClientMessageId)) {
          const fromIndex = firstIndexByClientId.get(fromClientMessageId)!;
          const toIndex = firstIndexByClientId.get(toClientMessageId)!;
          if (toIndex <= fromIndex) continue; // out of order or degenerate: fail open
          spansByFromId.set(fromClientMessageId, { summary, toClientMessageId });
        }
      }
    }

    let activeSpan: ArchiveSpan | null = null;
    if (openingSpan) {
      activeSpan = openingSpan;
      messages.push({ role: "user", content: openingSpan.summary });
    }

    // tool_use ids actually emitted into assistant message content blocks so
    // far. A tool_result whose tool_use_id isn't in this set — e.g. because
    // its opening tool_use fell inside an archived span while the (later,
    // preferred) real result landed outside it — would be an orphaned block
    // that breaks provider validation; skip it instead of emitting it.
    const emittedToolUseIds = new Set<string>();

    for (const event of this.events) {
      // Span bookkeeping runs on message events only: exit before entry so
      // adjacent spans (A.to === B.from) hand over on the boundary message.
      if (event.type === "message") {
        const clientMessageId =
          typeof event.data.clientMessageId === "string" ? event.data.clientMessageId : undefined;
        if (activeSpan && clientMessageId === activeSpan.toClientMessageId) {
          activeSpan = null;
        }
        if (!activeSpan && clientMessageId && spansByFromId.has(clientMessageId)) {
          activeSpan = spansByFromId.get(clientMessageId)!;
          // One-shot: a duplicate `from` message (e.g. from a torn JSONL
          // reload) must not reopen this span a second time — it would have
          // no more `to` ahead of it and swallow the rest of the transcript.
          spansByFromId.delete(clientMessageId);
          messages.push({ role: "user", content: activeSpan.summary });
        }
      }
      if (activeSpan) continue; // archived span: drop every context event inside

      switch (event.type) {
        case "message": {
          const { role, content, clientMessageId } = event.data as {
            role: string;
            content: string | ContentBlock[];
            clientMessageId?: unknown;
          };
          // Record the live index of this message's FIRST emission before
          // pushing it (the index it is about to occupy). Dropped-in-span
          // messages never reach this point, so they get no entry.
          if (
            typeof clientMessageId === "string" &&
            !liveIndexByClientMessageId.has(clientMessageId)
          ) {
            liveIndexByClientMessageId.set(clientMessageId, messages.length);
          }
          if (role === "assistant" && Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type === "tool_use" && typeof block.id === "string") {
                emittedToolUseIds.add(block.id);
              }
            }
          }
          messages.push({ role: role as Message["role"], content });
          break;
        }
        case "tool_use": {
          // Tool use is part of assistant message content blocks
          // Already included via the assistant message event
          break;
        }
        case "tool_result": {
          const eventToolCallId = event.data.toolCallId;
          if (
            typeof eventToolCallId !== "string" ||
            selectedToolResults.get(eventToolCallId) !== event ||
            !emittedToolUseIds.has(eventToolCallId)
          ) {
            break;
          }
          const { toolCallId, result, error, contentBlocks } = event.data as {
            toolCallId: string;
            result?: string;
            error?: string;
            contentBlocks?: ContentBlock[];
          };
          // Find if there's already a user message with tool_results to append to
          const lastMsg = messages[messages.length - 1];
          const block: ContentBlock = {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: error
              ? `Error: ${error}`
              : Array.isArray(contentBlocks) && contentBlocks.length > 0
                ? contentBlocks
                : (result ?? "(no output)"),
          };

          if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
            (lastMsg.content as ContentBlock[]).push(block);
          } else {
            messages.push({ role: "user", content: [block] });
          }
          break;
        }
        case "summary": {
          // Content replacement: inject summary as system-reminder
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Previous conversation was summarized:\n${summary}</system-reminder>`,
          });
          break;
        }
        case "context_transfer": {
          const { summary, handoffId } = event.data as { summary: string; handoffId?: string };
          messages.push({
            role: "user",
            content: handoffId
              ? `<system-reminder>Session handoff received:\n${summary}</system-reminder>`
              : `<system-reminder>Background context transferred from a selected conversation range:\n${summary}</system-reminder>`,
          });
          break;
        }
        // turn_boundary, run_result, session_meta, file_history, plan_operation, error
        // are not included in LLM messages. range_archive is handled entirely
        // by the pre-pass above (it emits the summary at span entry and drops
        // events inside the span); it never falls through to this switch.
      }
    }

    return { messages, liveIndexByClientMessageId };
  }

  getEvents(type?: TranscriptEventType): TranscriptEvent[] {
    if (!type) return [...this.events];
    return this.events.filter((e) => e.type === type);
  }

  get turnNumber(): number {
    return this.currentTurn;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** True once any event failed both persistence attempts. Sticky by design. */
  flushFailed(): boolean {
    return this.dirty;
  }

  /** Structured details for the most recent unrecoverable flush failure. */
  getFlushFailure(): TranscriptFlushFailure | undefined {
    return this.lastFlushFailure ? { ...this.lastFlushFailure } : undefined;
  }

  private findMessageByClientId(clientMessageId: string): TranscriptEvent | undefined {
    return this.events.find(
      (event) =>
        event.type === "message" &&
        (event.data as { clientMessageId?: unknown }).clientMessageId === clientMessageId,
    );
  }

  private flush(event: TranscriptEvent): boolean {
    if (!this.persistent) return true;
    const line = JSON.stringify(event) + "\n";
    try {
      this.writer(this.filePath, line, "utf-8");
      return true;
    } catch (firstError) {
      try {
        this.writer(this.filePath, line, "utf-8");
        logger.warn("transcript.flush_retry_recovered", {
          filePath: this.filePath,
          errno: this.errorErrno(firstError),
          message: this.errorMessage(firstError),
        });
        return true;
      } catch (retryError) {
        const err = retryError as NodeJS.ErrnoException;
        const failure: TranscriptFlushFailure = {
          errno: this.errorErrno(retryError),
          ...(typeof err?.code === "string" ? { code: err.code } : {}),
          message: this.errorMessage(retryError),
          timestamp: Date.now(),
          attempts: 2,
          recoverable: false,
          filePath: this.filePath,
        };
        // Sticky: a later successful append cannot restore an earlier missing
        // JSONL event, so the transcript remains degraded for this instance.
        this.dirty = true;
        this.lastFlushFailure = failure;
        logger.error("transcript.flush_failed", { ...failure });
        return false;
      }
    }
  }

  private errorErrno(error: unknown): string | number {
    const err = error as NodeJS.ErrnoException;
    if (typeof err?.errno === "number" || typeof err?.errno === "string") return err.errno;
    if (typeof err?.code === "string") return err.code;
    return "UNKNOWN";
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Normalize tool_result pairing in this detached in-memory snapshot:
   * - orphaned results are removed;
   * - duplicate results collapse to one, preferring a real result over the
   *   legacy synthetic interrupted placeholder;
   * - missing results remain missing. The run-resume boundary patches those
   *   in its request-local Message[] after it has established ownership.
   *
   * This method must never append to the JSONL file. loadFromFile is used by
   * read-only/background consumers while another run may be waiting for tool
   * approval; persisting a synthetic result there races the real executor.
   */
  repairToolResultPairs(): void {
    const selectedToolResults = preferredToolResults(this.events);
    this.events = this.events.filter((event) => {
      if (event.type !== "tool_result") return true;
      const toolCallId = event.data.toolCallId;
      return typeof toolCallId === "string" && selectedToolResults.get(toolCallId) === event;
    });
  }

  static readEvents(filePath: string): ParsedEvents {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return { events: [], malformedLineCount: 0 };
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const events: TranscriptEvent[] = [];
    let malformedLineCount = 0;
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        malformedLineCount++;
      }
    }
    return { events, malformedLineCount };
  }

  static eventsToMessages(events: readonly TranscriptEvent[]): Array<{
    role: string;
    content: string | ContentBlock[];
  }> {
    const messages: Array<{ role: string; content: string | ContentBlock[] }> = [];
    for (const event of events) {
      switch (event.type) {
        case "message": {
          const { role, content } = event.data as {
            role: string;
            content: string | ContentBlock[];
          };
          messages.push({ role, content });
          break;
        }
        case "tool_use":
          break;
        case "tool_result": {
          const { toolCallId, result, error, contentBlocks } = event.data as {
            toolCallId: string;
            result?: string;
            error?: string;
            contentBlocks?: ContentBlock[];
          };
          const block: ContentBlock = {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: error
              ? `Error: ${error}`
              : Array.isArray(contentBlocks) && contentBlocks.length > 0
                ? contentBlocks
                : (result ?? "(no output)"),
          };
          const last = messages[messages.length - 1];
          if (last?.role === "user" && Array.isArray(last.content)) {
            (last.content as ContentBlock[]).push(block);
          } else {
            messages.push({ role: "user", content: [block] });
          }
          break;
        }
        case "summary": {
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Previous conversation was summarized:\n${summary}</system-reminder>`,
          });
          break;
        }
        case "context_transfer": {
          const { summary, handoffId } = event.data as { summary: string; handoffId?: string };
          messages.push({
            role: "user",
            content: handoffId
              ? `<system-reminder>Session handoff received:\n${summary}</system-reminder>`
              : `<system-reminder>Background context transferred from a selected conversation range:\n${summary}</system-reminder>`,
          });
          break;
        }
        case "range_archive": {
          // A hand-picked context range is an explicit user selection: inject
          // the archive summary as context but do NOT replace/drop the
          // messages inside its span the way toMessages() does — the caller
          // asked for exactly this range and expects to see it in full.
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Archived summary for part of this range:\n${summary}</system-reminder>`,
          });
          break;
        }
      }
    }
    return messages;
  }

  /**
   * Select one inclusive, stable event-id range and project only LLM-context
   * events from it. Audit/UI events remain part of sourceEventCount but never
   * enter the package prompt.
   */
  static selectContextRange(
    events: readonly TranscriptEvent[],
    range: ContextEventRange,
  ): SelectedContextRange {
    const fromMatches = events
      .map((event, index) => (event.id === range.fromEventId ? index : -1))
      .filter((index) => index >= 0);
    const toMatches = events
      .map((event, index) => (event.id === range.toEventId ? index : -1))
      .filter((index) => index >= 0);
    if (fromMatches.length !== 1 || toMatches.length !== 1) {
      throw new Error("Context range endpoints must each identify exactly one source event");
    }
    const fromIndex = fromMatches[0]!;
    const toIndex = toMatches[0]!;
    if (fromIndex > toIndex) throw new Error("Context range endpoints are out of order");

    const frozen = structuredClone(events.slice(fromIndex, toIndex + 1));
    if (frozen[0]?.type === "session_meta" || frozen.at(-1)?.type === "session_meta") {
      throw new Error("Context range cannot use session metadata as a boundary");
    }
    const selected = frozen.filter((event) => CONTEXT_EVENT_TYPES.has(event.type));
    validateSelectedToolPairs(selected);
    return {
      events: selected,
      messages: Transcript.eventsToMessages(selected) as Message[],
      sourceEventCount: frozen.length,
    };
  }

  static loadFromFile(filePath: string): Transcript {
    const transcript = new Transcript(filePath);
    if (!existsSync(filePath)) return transcript;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as TranscriptEvent);
      } catch {
        // Skip malformed lines
      }
    }
    transcript.loadEvents(events);

    // Repair pairing on load
    transcript.repairToolResultPairs();

    return transcript;
  }

  private loadEvents(events: readonly TranscriptEvent[]): void {
    this.events = structuredClone([...events]);
    this.currentTurn = 0;
    for (const event of this.events) {
      if (event.type === "turn_boundary") {
        this.currentTurn =
          typeof event.data.turnNumber === "number" ? event.data.turnNumber : this.currentTurn + 1;
      }
    }
  }
}

function isEngineResultReceipt(value: unknown): value is EngineResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<EngineResult>;
  const usage = result.usage;
  return (
    typeof result.text === "string" &&
    typeof result.reason === "string" &&
    typeof result.sessionId === "string" &&
    typeof result.turnCount === "number" &&
    Number.isSafeInteger(result.turnCount) &&
    Boolean(usage) &&
    typeof usage?.promptTokens === "number" &&
    typeof usage?.completionTokens === "number" &&
    typeof usage?.totalTokens === "number"
  );
}

function validateSelectedToolPairs(events: readonly TranscriptEvent[]): void {
  const providerUses: string[] = [];
  const metadataUses: string[] = [];
  const results: string[] = [];

  for (const event of events) {
    if (event.type === "message") {
      const content = event.data.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (block.type === "tool_use" && typeof block.id === "string") providerUses.push(block.id);
      }
    } else if (event.type === "tool_use") {
      if (typeof event.data.toolCallId === "string") metadataUses.push(event.data.toolCallId);
    } else if (event.type === "tool_result") {
      if (typeof event.data.toolCallId === "string") results.push(event.data.toolCallId);
    }
  }

  if (new Set(providerUses).size !== providerUses.length) {
    throw new Error("Context range contains duplicate provider tool metadata");
  }
  if (new Set(metadataUses).size !== metadataUses.length) {
    throw new Error("Context range contains duplicate tool metadata");
  }
  if (new Set(results).size !== results.length) {
    throw new Error("Context range contains duplicate tool results");
  }
  if (
    providerUses.length !== metadataUses.length ||
    providerUses.some((id, index) => metadataUses[index] !== id)
  ) {
    throw new Error("Context range has orphaned or mismatched tool metadata");
  }

  const pending = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_use") {
      const id = event.data.toolCallId;
      if (typeof id === "string") pending.add(id);
    } else if (event.type === "tool_result") {
      const id = event.data.toolCallId;
      if (typeof id !== "string" || !pending.delete(id)) {
        throw new Error("Context range contains an orphaned or out-of-order tool result");
      }
    }
  }
  if (pending.size > 0) throw new Error("Context range ends with an unfinished tool round");
}
