/**
 * Transcript — JSONL event log (NOT chat history).
 * toMessages() derives Message[] from events for sending to LLM.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import type { TranscriptEvent, TranscriptEventType, Message, ContentBlock } from "../types.js";
import { logger } from "../logging/logger.js";

type TranscriptWriter = (filePath: string, data: string, encoding: "utf-8") => void;

type ParsedEvents = { events: TranscriptEvent[]; malformedLineCount: number };

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
]);

export class Transcript {
  private events: TranscriptEvent[] = [];
  private filePath: string;
  private currentTurn = 0;
  private readonly writer: TranscriptWriter;
  private dirty = false;
  private lastFlushFailure: TranscriptFlushFailure | undefined;

  getFilePath(): string {
    return this.filePath;
  }

  constructor(filePath: string, writer: TranscriptWriter = appendFileSync) {
    this.filePath = filePath;
    this.writer = writer;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, "", "utf-8");
    }
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
      ...(opts?.authority ? { authority: opts.authority } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
      ...(opts?.envelopeIds ? { envelopeIds: opts.envelopeIds } : {}),
      ...(opts?.correlationIds ? { correlationIds: opts.correlationIds } : {}),
    });
  }

  hasClientMessageId(clientMessageId: string): boolean {
    return this.findMessageByClientId(clientMessageId) !== undefined;
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

  appendError(error: string, details?: Record<string, unknown>): TranscriptEvent {
    return this.append("error", { error, ...details });
  }

  /**
   * Derive Message[] from transcript events for sending to the LLM.
   * This is the critical boundary: the LLM never sees the event log directly.
   */
  toMessages(): Message[] {
    const messages: Message[] = [];

    for (const event of this.events) {
      switch (event.type) {
        case "message": {
          const { role, content } = event.data as {
            role: string;
            content: string | ContentBlock[];
          };
          messages.push({ role: role as Message["role"], content });
          break;
        }
        case "tool_use": {
          // Tool use is part of assistant message content blocks
          // Already included via the assistant message event
          break;
        }
        case "tool_result": {
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
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Background context transferred from a selected conversation range:\n${summary}</system-reminder>`,
          });
          break;
        }
        // turn_boundary, session_meta, file_history, plan_operation, error
        // are not included in LLM messages
      }
    }

    return messages;
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
   * Repair tool_result pairing issues:
   * - Orphaned tool_results (no matching tool_use) get removed
   * - Missing tool_results (tool_use with no result) get synthetic error results
   */
  repairToolResultPairs(): void {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const event of this.events) {
      if (event.type === "tool_use") {
        toolUseIds.add(event.data.toolCallId as string);
      } else if (event.type === "tool_result") {
        toolResultIds.add(event.data.toolCallId as string);
      }
    }

    // Find tool_use events without matching tool_result
    for (const id of toolUseIds) {
      if (!toolResultIds.has(id)) {
        // Synthesize an error result
        this.append("tool_result", {
          toolCallId: id,
          toolName: "unknown",
          error: "[Tool result missing due to interrupted session]",
        });
      }
    }

    // Remove orphaned tool_results (result without matching use)
    this.events = this.events.filter((event) => {
      if (event.type === "tool_result") {
        const id = event.data.toolCallId as string;
        return toolUseIds.has(id);
      }
      return true;
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
          const { summary } = event.data as { summary: string };
          messages.push({
            role: "user",
            content: `<system-reminder>Background context transferred from a selected conversation range:\n${summary}</system-reminder>`,
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

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TranscriptEvent;
        transcript.events.push(event);
        if (event.type === "turn_boundary") {
          transcript.currentTurn = (event.data.turnNumber as number) ?? transcript.currentTurn + 1;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Repair pairing on load
    transcript.repairToolResultPairs();

    return transcript;
  }
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
