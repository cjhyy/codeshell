/**
 * Shared building blocks for the messages reducer: id minting, timestamp
 * validation, run timing on the user anchor, sealing unfinished thinking /
 * tool rows, the per-turn usage line and the files-changed card. Used by
 * several event handlers and the append* entry points, so they live here
 * rather than in any one event family.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import { isSystemReminderText } from "../contextSelection";
import type { aggregateFileChangeSummary } from "../messages/fileChangeAggregator";
import type {
  FilesChangedSummaryMessage,
  Message,
  MessagesReducerState,
  ThinkingMessage,
  ToolMessage,
  UserMessage,
} from "../messageTypes";

let _counter = 0;
export function freshId(prefix: string): string {
  _counter += 1;
  return `${prefix}-${Date.now()}-${_counter}`;
}

export function assistantMessageToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

export function sealToolWithoutResult(
  tool: ToolMessage,
  endedAt: number,
  status: "failed" | "cancelled" = "failed",
): ToolMessage {
  if (tool.status !== "running" && tool.status !== "queued") return tool;
  return {
    ...tool,
    status,
    error:
      tool.error ?? (status === "cancelled" ? undefined : "Tool execution ended without a result."),
    endedAt,
    durationMs: toolDurationMs(tool.startedAt, endedAt),
  };
}

export function findThinkingFromEnd(
  messages: Message[],
  thinkingId: string | null,
): { index: number; message: ThinkingMessage } | undefined {
  if (!thinkingId) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.kind === "thinking" && message.id === thinkingId) return { index, message };
  }
  return undefined;
}

/**
 * Finish the live thinking row once the model has moved on (answer text, a
 * tool call, a new request, an error). The pointer is intentionally left in
 * place by callers that keep the request alive: a tombstone of the current
 * assistant still removes this row, and the next thinking_delta sees a done
 * row and opens a fresh one in stream order. Without sealing, a pointer reset
 * orphaned the row with done:false and its "正在思考…" spinner never stopped.
 */
export function sealStreamingThinking(messages: Message[], thinkingId: string | null): Message[] {
  const found = findThinkingFromEnd(messages, thinkingId);
  if (!found || found.message.done) return messages;
  const next = messages.slice();
  next[found.index] = { ...found.message, done: true };
  return next;
}

export function validTime(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function validTimestamp(value: number | undefined): number | undefined {
  // Older persisted projections used 0 when the source timestamp was absent.
  return value === 0 ? undefined : validTime(value);
}

export function toolDurationMs(startedAt: number, endedAt: number): number | undefined {
  return validTimestamp(startedAt) !== undefined && validTimestamp(endedAt) !== undefined
    ? Math.max(0, endedAt - startedAt)
    : undefined;
}

export function withTurnTiming(
  messages: Message[],
  event: Extract<
    StreamEvent,
    { type: "session_started" | "stream_request_start" | "turn_complete" }
  >,
  timestamp: number | undefined,
): Message[] {
  // Keep the same boundaries as the process fold: a steer (including legacy
  // id-less steers) cannot take timing away from an unfinished run. A wakeup
  // after a terminal run opens a new segment.
  let index = -1;
  let legacyAssistantDone = false;
  let runningTool = false;
  let ended = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.kind === "user" && !message.pending && !message.steerId) {
      const anchor = messages[index];
      const timing = anchor?.kind === "user" ? anchor.turnTiming : undefined;
      const completed =
        ended ||
        (timing
          ? timing.completed === true || timing.completedAt !== undefined
          : legacyAssistantDone && !runningTool);
      const injected = message.injected === true || isSystemReminderText(message.text);
      if (!injected || index < 0 || completed) {
        index = i;
        legacyAssistantDone = false;
        runningTool = false;
        ended = false;
      }
    } else if (message.kind === "assistant") legacyAssistantDone = message.done;
    else if (
      message.kind === "tool" &&
      (message.status === "running" || message.status === "queued")
    )
      runningTool = true;
    else if (message.kind === "turn_end") ended = true;
  }
  const user = messages[index];
  if (!user || user.kind !== "user") return messages;
  const previous = user.turnTiming;
  let timing: NonNullable<UserMessage["turnTiming"]>;
  if (event.type === "session_started") {
    timing = { startedAt: validTimestamp(event.startedAt) ?? validTimestamp(timestamp) };
  } else if (event.type === "stream_request_start") {
    if (previous) return messages;
    timing = { startedAt: validTimestamp(user.createdAt) ?? validTimestamp(timestamp) };
  } else {
    const startedAt =
      validTimestamp(event.startedAt) ??
      validTimestamp(previous?.startedAt) ??
      validTimestamp(user.createdAt);
    const completedAt =
      validTimestamp(event.completedAt) ??
      validTimestamp(previous?.completedAt) ??
      validTimestamp(timestamp);
    timing = {
      startedAt,
      completedAt,
      durationMs:
        validTime(event.durationMs) ??
        previous?.durationMs ??
        (startedAt !== undefined && completedAt !== undefined
          ? Math.max(0, completedAt - startedAt)
          : undefined),
      completed: true,
      completedCleanly: event.reason === "completed",
    };
  }
  const next = messages.slice();
  next[index] = {
    ...user,
    ...(event.type === "session_started" && event.runId
      ? { sourceEventId: user.sourceEventId ?? event.runId }
      : {}),
    turnTiming: timing,
  };
  return next;
}

export function logChangedFiles(stage: string, data: Record<string, unknown>): void {
  if (typeof window === "undefined" || !window.codeshell?.log) return;
  window.codeshell.log(`changed_files.${stage}`, data);
}

export function filesChangedMessage(
  summary: NonNullable<ReturnType<typeof aggregateFileChangeSummary>>,
  id = freshId("files-changed"),
): FilesChangedSummaryMessage {
  const totalAdded = summary.files.reduce((acc, entry) => acc + entry.added, 0);
  const totalRemoved = summary.files.reduce((acc, entry) => acc + entry.removed, 0);
  return {
    kind: "files_changed",
    id,
    files: summary.files,
    totalAdded,
    totalRemoved,
    sessionDiffs: summary.sessionDiffs,
  };
}

export function withTurnUsage(messages: Message[], state: MessagesReducerState): Message[] {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === "user" && !(messages[i] as UserMessage).injected) {
      start = i;
      break;
    }
  }
  const previous = messages.find((message, i) => i > start && message.kind === "turn_usage");
  const next = messages.filter((message, i) => !(i > start && message.kind === "turn_usage"));
  if (
    state.singleTurnPromptTokens > 0 ||
    state.singleTurnCacheReadTokens > 0 ||
    state.singleTurnCacheCreationTokens > 0
  ) {
    next.push({
      kind: "turn_usage",
      id: previous?.id ?? freshId("turn-usage"),
      promptTokens: state.singleTurnPromptTokens,
      cacheReadTokens: state.singleTurnCacheReadTokens,
      cacheCreationTokens: state.singleTurnCacheCreationTokens,
    });
  }
  return next;
}
