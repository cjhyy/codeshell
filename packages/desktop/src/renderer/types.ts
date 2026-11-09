/**
 * Renderer-local message model. The agent worker streams individual
 * StreamEvents; the renderer accumulates them into a list of Message
 * objects that React renders. One assistant text reply is one
 * Message; one tool call (start → result) is one Message.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import { projectOutputUserEvent } from "@cjhyy/code-shell-web";
import type { ApprovalRequestEnvelope } from "../preload/types";
import type { MessageClock, MessagesReducerState, StreamRunProjection } from "./messageTypes";
import {
  applyAgentBackgrounded,
  applyAgentEnd,
  applyAgentHeartbeat,
  applyAgentStart,
  applyBackgroundAgentCompleted,
} from "./messages-reducer/agentEvents";
import {
  applyAssistantMessage,
  applyContextCompact,
  applySessionStarted,
  applySessionUserMessage,
  applySteerInjected,
  applyStreamRequestStart,
  applyTaskUpdate,
  applyTextDelta,
  applyThinkingDelta,
} from "./messages-reducer/feedEvents";
import {
  applyGoalCleared,
  applyGoalProgress,
  applyGoalSet,
  applyGoalUpdated,
} from "./messages-reducer/goalEvents";
import { validTimestamp, withTurnUsage } from "./messages-reducer/helpers";
import {
  applyToolResult,
  applyToolSummary,
  applyToolUseArgsDelta,
  applyToolUseStart,
} from "./messages-reducer/toolEvents";
import { applyTurnDiff, refreshTurnDiffForAgent } from "./messages-reducer/turnDiff";
import {
  applyErrorEvent,
  applyTombstone,
  applyTurnComplete,
  applyUsageUpdate,
} from "./messages-reducer/turnEndEvents";

// The message model and the reducer's per-event handlers live in
// ./messageTypes and ./messages-reducer/; this module keeps the public
// surface (re-exported below), the initial state, and the run routing that
// scopes each event to its owning user turn before dispatching it.
export type {
  ActiveGoal,
  AgentMessage,
  AgentRuntime,
  AskUserMessage,
  AskUserOption,
  AssistantMessage,
  ContextBoundaryMessage,
  ExternalFileOrigin,
  FileEditEntry,
  FilesChangedSummaryMessage,
  GoalProgressMessage,
  Message,
  MessageClock,
  MessagesReducerState,
  SessionFileDiff,
  SystemMessage,
  TaskListMessage,
  ThinkingMessage,
  ToolImageBlock,
  ToolMessage,
  ToolStatus,
  TurnEndMessage,
  TurnUsageMessage,
  UserMessage,
} from "./messageTypes";
export { bgCompletionText } from "./messages-reducer/agentEvents";
export {
  appendAskUserMessage,
  appendTurnEndMessage,
  appendUserMessage,
  markAskUserAnswered,
  removePendingSteerMessages,
} from "./messages-reducer/appenders";

export const INITIAL_STATE: MessagesReducerState = {
  messages: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  sessionId: null,
  promptTokens: 0,
  singleTurnPromptTokens: 0,
  singleTurnCacheReadTokens: 0,
  singleTurnCacheCreationTokens: 0,
  cumulativePromptTokens: 0,
  cumulativeCacheReadTokens: 0,
  cumulativeCacheCreationTokens: 0,
  sessionCacheReadTokens: 0,
  sessionCacheCreationTokens: 0,
  sessionPromptTokens: 0,
  activeAgents: {},
  agentMessageIndex: {},
  snapshotSeq: 0,
  turnEpoch: 0,
  activeGoal: null,
};

/** Old snapshots include auxiliary usage; never merge those totals into main-call counts. */
export function mergeCumulativeCacheUsage(left: MessagesReducerState, right: MessagesReducerState) {
  const sameScope = left.cacheUsageVersion === right.cacheUsageVersion;
  const primary = left.cacheUsageVersion === 1 ? left : right;
  const prompt = sameScope
    ? Math.max(left.cumulativePromptTokens, right.cumulativePromptTokens)
    : primary.cumulativePromptTokens;
  const read = sameScope
    ? Math.max(left.cumulativeCacheReadTokens, right.cumulativeCacheReadTokens)
    : primary.cumulativeCacheReadTokens;
  const creation = sameScope
    ? Math.max(left.cumulativeCacheCreationTokens, right.cumulativeCacheCreationTokens)
    : primary.cumulativeCacheCreationTokens;
  return {
    cacheUsageVersion: primary.cacheUsageVersion,
    cumulativePromptTokens: prompt,
    cumulativeCacheReadTokens: read,
    cumulativeCacheCreationTokens: creation,
    sessionPromptTokens: prompt,
    sessionCacheReadTokens: read,
    sessionCacheCreationTokens: creation,
  };
}

/**
 * Fold a single StreamEvent into the message list. Pure — returns a
 * new state. Unknown event types are no-ops so future Engine event
 * additions don't break the renderer.
 */
export function applyStreamEvent(
  state: MessagesReducerState,
  event: StreamEvent,
  now: MessageClock = Date.now,
): MessagesReducerState {
  // A journal replay or delayed/reconnected delivery must retain the source
  // event's time. Sample the fallback clock once so one event has one timestamp.
  const eventTime = validTimestamp(event.timestamp) ?? now();
  now = () => eventTime;
  if (
    (event.type === "session_user_message" || event.type === "steer_injected") &&
    "agentId" in event &&
    event.agentId
  )
    return state;
  if (event.type === "turn_diff") return applyTurnDiff(state, event, event.capturedAt ?? eventTime);
  event = projectOutputUserEvent(event);
  if (
    ("agentId" in event && event.agentId !== undefined) ||
    event.type === "session_user_message" ||
    event.type === "steer_injected"
  ) {
    const next = applyStreamEventToTurn(state, event, now);
    return "agentId" in event &&
      event.agentId &&
      ["tool_use_start", "tool_result", "agent_end"].includes(event.type)
      ? refreshTurnDiffForAgent(next, event.agentId)
      : next;
  }
  const runs = state.streamRuns ?? {};
  const knownKey = Object.keys(runs).find((key) =>
    event.runId
      ? runs[key]!.runId === event.runId
      : event.clientMessageId
        ? runs[key]!.clientMessageId === event.clientMessageId
        : false,
  );
  const latestUser = state.messages
    .slice()
    .reverse()
    .find((message) => message.kind === "user" && !message.injected && !message.pending);
  const owner = event.clientMessageId
    ? state.messages.find(
        (message) => message.kind === "user" && message.clientMessageId === event.clientMessageId,
      )
    : knownKey
      ? state.messages.find((message) => message.id === runs[knownKey]!.userMessageId)
      : latestUser;
  // Legacy streams keep their established run until the next start. Native
  // streams carry identities, including terminal callbacks after Stop.
  const startsLegacyTurn =
    !event.runId &&
    !event.clientMessageId &&
    owner?.kind === "user" &&
    (event.type === "session_started" ||
      (event.type === "stream_request_start" &&
        !owner.injected &&
        runs[state.activeStreamRunKey ?? ""]?.userMessageId !== owner.id));
  const key =
    knownKey ??
    (event.runId
      ? `run:${event.runId}`
      : event.clientMessageId
        ? `client:${event.clientMessageId}`
        : startsLegacyTurn && owner
          ? `legacy:${owner.id}`
          : state.activeStreamRunKey);
  // Snapshot prefixes can omit the originating user. Without a known anchor,
  // retain the legacy fold instead of silently discarding recovered output.
  if (!owner && (event.runId || event.clientMessageId) && latestUser) return state;
  if (!owner || !key) return applyStreamEventToTurn(state, event, now);
  if (
    !knownKey &&
    event.runId &&
    event.type !== "session_started" &&
    state.activeStreamRunKey &&
    !event.clientMessageId
  ) {
    // A detached callback without a known user anchor cannot own the new run.
    return state;
  }
  const previous = runs[key];
  const ownerId = previous?.userMessageId ?? owner.id;
  const start = state.messages.findIndex((message) => message.id === ownerId);
  if (start < 0) return state;
  const endOffset = state.messages
    .slice(start + 1)
    .findIndex((message) => message.kind === "user" && !message.injected && !message.pending);
  const end = endOffset < 0 ? state.messages.length : start + 1 + endOffset;
  const historical = end < state.messages.length;
  const sameAnchorOlderRun =
    !historical &&
    !!knownKey &&
    !!state.activeStreamRunKey &&
    key !== state.activeStreamRunKey &&
    runs[state.activeStreamRunKey]?.userMessageId === ownerId;
  if (sameAnchorOlderRun) return state;

  const fresh = (event.type === "session_started" || startsLegacyTurn) && !previous;
  let scoped = historical
    ? {
        ...state,
        messages: state.messages.slice(start, end),
        streamingAssistantId: previous?.streamingAssistantId ?? null,
        streamingThinkingId: previous?.streamingThinkingId ?? null,
        promptTokens: previous?.promptTokens ?? 0,
        singleTurnPromptTokens: previous?.singleTurnPromptTokens ?? 0,
        singleTurnCacheReadTokens: previous?.singleTurnCacheReadTokens ?? 0,
        singleTurnCacheCreationTokens: previous?.singleTurnCacheCreationTokens ?? 0,
        activeAgents: Object.fromEntries(
          Object.entries(state.activeAgents).filter(([id]) => {
            const index = state.agentMessageIndex[id];
            return index !== undefined && index >= start && index < end;
          }),
        ),
        agentMessageIndex: Object.fromEntries(
          Object.entries(state.agentMessageIndex).flatMap(([id, index]) =>
            index >= start && index < end ? [[id, index - start]] : [],
          ),
        ),
      }
    : state;
  if (fresh)
    scoped = {
      ...scoped,
      singleTurnPromptTokens: 0,
      singleTurnCacheReadTokens: 0,
      singleTurnCacheCreationTokens: 0,
    };
  const stoppedAssistantId = previous?.stopped ? previous.streamingAssistantId : undefined;
  const stoppedAssistant = stoppedAssistantId
    ? scoped.messages.find(
        (message) => message.kind === "assistant" && message.id === stoppedAssistantId,
      )
    : undefined;
  // Stop seals the displayed segment immediately. Already-produced deltas can
  // still arrive before its durable terminal; retain them on that exact run's
  // sealed segment, without reopening a spinner or moving text past Stop.
  let next =
    event.type === "text_delta" && stoppedAssistant
      ? {
          ...scoped,
          messages: scoped.messages.map((message) =>
            message === stoppedAssistant && message.kind === "assistant"
              ? { ...message, text: message.text + event.text }
              : message,
          ),
        }
      : applyStreamEventToTurn(scoped, event, now);
  if (event.type === "usage_update" && (previous?.completed || previous?.stopped)) {
    next = { ...next, messages: withTurnUsage(next.messages, next) };
  }
  const projection: StreamRunProjection = {
    runId: event.runId ?? previous?.runId,
    clientMessageId: event.clientMessageId ?? previous?.clientMessageId,
    userMessageId: ownerId,
    streamingAssistantId:
      previous?.stopped && event.type !== "turn_complete"
        ? previous.streamingAssistantId
        : next.streamingAssistantId,
    streamingThinkingId: next.streamingThinkingId,
    promptTokens: next.promptTokens,
    singleTurnPromptTokens: next.singleTurnPromptTokens,
    singleTurnCacheReadTokens: next.singleTurnCacheReadTokens,
    singleTurnCacheCreationTokens: next.singleTurnCacheCreationTokens,
    completed: previous?.completed || event.type === "turn_complete",
    stopped: previous?.stopped,
  };
  const presentIds = new Set(state.messages.map((message) => message.id));
  const streamRuns = {
    ...Object.fromEntries(
      Object.entries(runs).filter(([, run]) => presentIds.has(run.userMessageId)),
    ),
    [key]: projection,
  };
  if (!historical) return { ...next, streamRuns, activeStreamRunKey: key };
  // Late output is folded into its original turn, before a newer user bubble.
  // Never adopt the old run's streaming pointers, usage gauge or completion epoch.
  const messages = [
    ...state.messages.slice(0, start),
    ...next.messages,
    ...state.messages.slice(end),
  ];
  const activeAgents = { ...state.activeAgents };
  for (const id of Object.keys(scoped.activeAgents)) delete activeAgents[id];
  Object.assign(activeAgents, next.activeAgents);
  return {
    ...state,
    messages,
    streamRuns,
    activeAgents,
    agentMessageIndex: Object.fromEntries(
      messages.flatMap((message, index) => (message.kind === "agent" ? [[message.id, index]] : [])),
    ),
    ...mergeCumulativeCacheUsage(state, next),
  };
}

/** Host lifecycle effects must follow the newest submitted user turn too. */
export function isCurrentStreamRunEvent(
  state: MessagesReducerState | undefined,
  event: StreamEvent,
): boolean {
  if (!state) return true;
  const latestUser = state.messages
    .slice()
    .reverse()
    .find((message) => message.kind === "user" && !message.injected && !message.pending);
  const runs = state.streamRuns ?? {};
  const active = state.activeStreamRunKey ? runs[state.activeStreamRunKey] : undefined;
  if (
    event.type !== "session_started" &&
    event.runId &&
    active?.runId &&
    event.runId !== active.runId
  )
    return false;
  if (event.clientMessageId && latestUser?.kind === "user" && latestUser.clientMessageId) {
    return event.clientMessageId === latestUser.clientMessageId;
  }
  const run = event.runId
    ? Object.values(runs).find((candidate) => candidate.runId === event.runId)
    : state.activeStreamRunKey
      ? runs[state.activeStreamRunKey]
      : undefined;
  if (run && latestUser && run.userMessageId !== latestUser.id) {
    const owner = state.messages.findIndex((message) => message.id === run.userMessageId);
    const latest = state.messages.indexOf(latestUser);
    if (owner < latest) return false;
  }
  return (
    event.type === "session_started" ||
    !event.runId ||
    !active?.runId ||
    event.runId === active.runId
  );
}

function applyStreamEventToTurn(
  state: MessagesReducerState,
  event: StreamEvent,
  now: MessageClock,
): MessagesReducerState {
  switch (event.type) {
    case "session_user_message":
      return applySessionUserMessage(state, event, now);
    case "session_started":
      return applySessionStarted(state, event, now);
    case "stream_request_start":
      return applyStreamRequestStart(state, event, now);
    case "steer_injected":
      return applySteerInjected(state, event, now);
    case "text_delta":
      return applyTextDelta(state, event, now);
    case "thinking_delta":
      return applyThinkingDelta(state, event);
    case "tool_use_start":
      return applyToolUseStart(state, event, now);
    case "tool_use_args_delta":
      return applyToolUseArgsDelta(state, event);
    case "tool_result":
      return applyToolResult(state, event, now);
    case "tool_summary":
      return applyToolSummary(state, event);
    case "assistant_message":
      return applyAssistantMessage(state, event, now);
    case "task_update":
      return applyTaskUpdate(state, event);
    case "agent_start":
      return applyAgentStart(state, event, now);
    case "agent_backgrounded":
      return applyAgentBackgrounded(state, event);
    case "agent_heartbeat":
      return applyAgentHeartbeat(state, event);
    case "agent_end":
      return applyAgentEnd(state, event, now);
    case "context_compact":
      return applyContextCompact(state, event);
    case "goal_progress":
      return applyGoalProgress(state, event, now);
    case "goal_set":
      return applyGoalSet(state, event, now);
    case "goal_updated":
      return applyGoalUpdated(state, event, now);
    case "goal_cleared":
      return applyGoalCleared(state, event, now);
    case "usage_update":
      return applyUsageUpdate(state, event);
    case "tombstone":
      return applyTombstone(state, event);
    case "turn_complete":
      return applyTurnComplete(state, event, now);
    case "error":
      return applyErrorEvent(state, event);
    case "background_agent_completed":
      return applyBackgroundAgentCompleted(state, event, now);
    default:
      return state; // unknown / unhandled events — ignore
  }
}

/**
 * Answer one pending question. With `skip`, decline it without an answer;
 * `answer` is then only the local record label (e.g. 已跳过).
 */
export type AskUserAnswerHandler = (
  requestId: string,
  answer: string,
  skip?: boolean,
) => void | Promise<void>;

export type ApprovalState = ApprovalRequestEnvelope | null;
