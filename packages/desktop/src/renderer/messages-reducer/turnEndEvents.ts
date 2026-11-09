/**
 * Turn accounting and termination events: usage readings, tombstoned
 * (revoked) output, turn completion (agent sweep, pointer finalization,
 * files-changed and usage cards) and stream errors. Each handler is one case
 * of the reducer switch in ../types.ts, moved verbatim.
 */

import type { StreamEvent } from "@cjhyy/code-shell-core";
import { goalRunEnded } from "../goalClock";
import { aggregateFileChangeSummary } from "../messages/fileChangeAggregator";
import type { Message, MessageClock, MessagesReducerState } from "../messageTypes";
import {
  filesChangedMessage,
  freshId,
  logChangedFiles,
  sealStreamingThinking,
  sealToolWithoutResult,
  withTurnTiming,
  withTurnUsage,
} from "./helpers";

export function applyUsageUpdate(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "usage_update" }>,
): MessagesReducerState {
  const acceptsCacheUsage = state.cacheUsageVersion !== 1 || event.cacheUsageVersion === 1;
  // Fields update independently and additively — a single event can carry
  // any combination of them. The turn-loop's per-response emit carries the
  // context reading + single-turn cache + cumulative cache all at once, so
  // we must NOT early-return on cumulative presence (that dropped the
  // single-turn metric and left its tooltip row stuck at nothing).
  const hasCumulative =
    event.cumulativePromptTokens !== undefined || event.sessionPromptTokens !== undefined;
  const hasSingleTurn =
    event.singleTurnPromptTokens !== undefined ||
    event.cacheReadTokens !== undefined ||
    event.cacheCreationTokens !== undefined;
  // A pure cumulative-only heartbeat (engine turn boundary) carries a
  // cumulative-derived promptTokens that must NOT clobber the live context
  // reading. Only adopt event.promptTokens when it's a real reading, i.e.
  // not a heartbeat that lacks any single-turn signal.
  const isCumulativeHeartbeat = hasCumulative && !hasSingleTurn;
  const hasLivePromptReading = Number.isFinite(event.promptTokens) && event.promptTokens > 0;
  return {
    ...state,
    ...(event.cacheUsageVersion === 1 && state.cacheUsageVersion !== 1
      ? {
          singleTurnPromptTokens: 0,
          singleTurnCacheReadTokens: 0,
          singleTurnCacheCreationTokens: 0,
          cumulativePromptTokens: 0,
          cumulativeCacheReadTokens: 0,
          cumulativeCacheCreationTokens: 0,
          sessionPromptTokens: 0,
          sessionCacheReadTokens: 0,
          sessionCacheCreationTokens: 0,
        }
      : {}),
    ...(isCumulativeHeartbeat || !hasLivePromptReading ? {} : { promptTokens: event.promptTokens }),
    ...(acceptsCacheUsage && event.cacheUsageVersion === 1 ? { cacheUsageVersion: 1 } : {}),
    ...(hasSingleTurn && acceptsCacheUsage
      ? {
          singleTurnPromptTokens: event.singleTurnPromptTokens ?? event.promptTokens,
          singleTurnCacheReadTokens: event.singleTurnCacheReadTokens ?? event.cacheReadTokens ?? 0,
          singleTurnCacheCreationTokens:
            event.singleTurnCacheCreationTokens ?? event.cacheCreationTokens ?? 0,
        }
      : {}),
    ...(hasCumulative && acceptsCacheUsage
      ? (() => {
          const cumulativePromptTokens =
            event.cumulativePromptTokens ?? event.sessionPromptTokens ?? 0;
          const cumulativeCacheReadTokens =
            event.cumulativeCacheReadTokens ?? event.sessionCacheReadTokens ?? 0;
          const cumulativeCacheCreationTokens =
            event.cumulativeCacheCreationTokens ?? event.sessionCacheCreationTokens ?? 0;
          return {
            cumulativePromptTokens,
            cumulativeCacheReadTokens,
            cumulativeCacheCreationTokens,
            sessionPromptTokens: cumulativePromptTokens,
            sessionCacheReadTokens: cumulativeCacheReadTokens,
            sessionCacheCreationTokens: cumulativeCacheCreationTokens,
          };
        })()
      : {}),
  };
}

export function applyTombstone(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "tombstone" }>,
): MessagesReducerState {
  if (event.agentId) {
    const index = state.agentMessageIndex[event.agentId];
    const agent = index === undefined ? undefined : state.messages[index];
    if (agent?.kind !== "agent") return state;
    const request =
      !agent.done &&
      agent.streamingTextRequest &&
      agent.streamingTextRequest.messageId === event.messageId
        ? agent.streamingTextRequest
        : undefined;
    if (!request && !agent.toolCalls.some((tool) => tool.id === event.messageId)) return state;
    const messages = [...state.messages];
    const toolCalls = agent.toolCalls.filter((tool) => tool.id !== event.messageId);
    messages[index!] = {
      ...agent,
      toolCalls,
      toolCount: toolCalls.length,
      ...(request
        ? {
            text: agent.text?.slice(0, request.startOffset),
            textBuffer: agent.textBuffer.slice(
              0,
              Math.max(0, request.startOffset - (agent.text?.length ?? 0)),
            ),
            streamingTextRequest: undefined,
          }
        : {}),
    };
    return { ...state, messages };
  }
  // Find the doomed message's index so we can adjust agentMessageIndex.
  const removedIdx = state.messages.findIndex((m) => m.id === event.messageId);
  const removesCurrentAssistant = state.streamingAssistantId === event.messageId;
  // A tool-first stream can already have dropped its empty assistant
  // placeholder; its live-turn anchor still owns the thinking row.
  if (removedIdx < 0 && !removesCurrentAssistant) return state;
  const thinkingId = removesCurrentAssistant ? state.streamingThinkingId : null;
  const removedIndexes = state.messages.flatMap((message, index) =>
    index === removedIdx || (thinkingId !== null && message.id === thinkingId) ? [index] : [],
  );
  const messages = state.messages.filter((_, i) => !removedIndexes.includes(i));
  // Drop the entry for the removed agent (if it was an AgentMessage),
  // decrement every index that pointed past the removed slot.
  const removed = state.messages[removedIdx];
  const agentMessageIndex: Record<string, number> = {};
  for (const [agentId, idx] of Object.entries(state.agentMessageIndex)) {
    if (removed?.kind === "agent" && agentId === removed.id) continue;
    agentMessageIndex[agentId] = idx - removedIndexes.filter((removed) => removed < idx).length;
  }
  return {
    ...state,
    messages,
    agentMessageIndex,
    streamingAssistantId:
      state.streamingAssistantId === event.messageId ? null : state.streamingAssistantId,
    streamingThinkingId: removesCurrentAssistant ? null : state.streamingThinkingId,
  };
}

export function applyTurnComplete(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "turn_complete" }>,
  now: MessageClock,
): MessagesReducerState {
  if (event.agentId) return state;
  // 1. Flush every active agent's textBuffer to its `text` field, and on a
  //    CLEAN completion also mark any still-running agent done. A cleanly
  //    completed main turn means no foreground subagent is legitimately
  //    still running — a leftover done:false agent is an orphan whose
  //    agent_end was dropped/raced (worker died, or agent_end arrived with
  //    no matching agent_start index). Without this sweep that orphan keeps
  //    `runningAgents` > 0 forever, so "后台 N 个子代理运行中…" sticks after
  //    the turn ends. (#4 stuck background count) A genuinely-backgrounded
  //    agent reports separately via background_agent_completed.
  const cleanSweep = event.reason === "completed";
  const msgs = withTurnTiming(state.messages, event, now()).slice();
  const nextActiveAgents = { ...state.activeAgents };
  for (const agentId of Object.keys(state.activeAgents)) {
    const idx = state.agentMessageIndex[agentId];
    if (idx === undefined) {
      if (cleanSweep) delete nextActiveAgents[agentId];
      continue;
    }
    const m = msgs[idx];
    if (!m || m.kind !== "agent") {
      if (cleanSweep) delete nextActiveAgents[agentId];
      continue;
    }
    const flushedText = m.textBuffer.length > 0 ? (m.text ?? "") + m.textBuffer : m.text;
    if (cleanSweep && !m.done && !m.backgrounded) {
      // Sweep only true ORPHANS (agent_start, no agent_end, agent_end
      // dropped/raced). A `backgrounded` agent is legitimately still running
      // after the parent turn ends — it reports done later via agent_end /
      // background_agent_completed — so it must NOT be swept here (else the
      // card collapses + loses its "running" state). Still flush its buffer.
      const endedAt = m.endedAt ?? now() ?? m.startedAt;
      msgs[idx] = {
        ...m,
        text: flushedText,
        textBuffer: "",
        done: true,
        endedAt,
        toolCalls: m.toolCalls.map((tool) => sealToolWithoutResult(tool, endedAt)),
      };
      delete nextActiveAgents[agentId];
    } else if (cleanSweep && !m.backgrounded) {
      delete nextActiveAgents[agentId];
    } else if (m.textBuffer.length > 0) {
      msgs[idx] = { ...m, text: flushedText, textBuffer: "" };
    }
  }

  // 2. Finalize streaming pointers (existing behavior).
  const turnDoneAt = now();
  let finalized: Message[] = msgs.map((m) => {
    if (m.kind === "assistant" && !m.done) {
      return { ...m, done: true, doneAt: m.doneAt ?? turnDoneAt };
    }
    // Every thinking row is over once the turn is. Matching only the live
    // pointer left earlier rows spinning if any path reset the pointer
    // without sealing them first.
    if (m.kind === "thinking" && !m.done) {
      return { ...m, done: true };
    }
    // A terminal turn cannot still own a running top-level tool. Normally
    // tool_result closes it first; this is the defensive recovery path for
    // a provider/runtime that ended or reconnected without that event.
    // Leaving it running makes the card claim "working" indefinitely.
    if (m.kind === "tool" && m.status === "running") {
      const endedAt = turnDoneAt ?? m.startedAt;
      return sealToolWithoutResult(m, endedAt);
    }
    return m;
  });

  // 3. Compute the per-turn files-changed summary. Remove any prior
  //    files_changed from this logical task first so multiple turn_complete
  //    events don't stack. The boundary MUST match aggregateFileChangeSummary:
  //    scope to the last NON-injected user message. A goal/steer task spans
  //    many engine.run boundaries — each inserts an injected user turn — and
  //    the new card already re-aggregates edits from ALL of them. Anchoring
  //    the sweep on the last user message of ANY kind would leave earlier
  //    runs' cards standing (they sit before the injected user turn), so a
  //    file edited across runs would show in two cards (#9 follow-up).
  let lastUserIdx = -1;
  for (let i = finalized.length - 1; i >= 0; i--) {
    const m = finalized[i];
    if (m.kind === "user" && !m.injected) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0) {
    finalized = finalized.filter((m, i) => !(i > lastUserIdx && m.kind === "files_changed"));
  }
  const summary = aggregateFileChangeSummary(finalized);
  if (summary?.files.length) {
    const card = filesChangedMessage(summary);
    const entries = card.files;
    finalized = [...finalized, card];
    logChangedFiles("renderer.aggregated", {
      sessionId: state.sessionId,
      size: entries.length,
      files: entries.map((entry) => entry.path),
      totalAdded: card.totalAdded,
      totalRemoved: card.totalRemoved,
    });
  }

  // 4. Report what this turn consumed. Like the files-changed card, drop any
  //    prior summary for this task first so repeated turn_complete events
  //    don't stack. Only when something was actually spent — a no-op turn
  //    adds no line.
  finalized = withTurnUsage(finalized, state);

  // Only a cleanly completed turn bumps turnEpoch — that counter is what
  // force-collapses tool cards back to their summary (ToolGroupCard /
  // ToolCardShell watch it). An abnormal end (model_error, aborted_*,
  // prompt_too_long, …) often fires mid-task on a transient error and
  // should NOT yank the cards the user is reading shut; we still flush and
  // finalize above, just don't advance the epoch.
  const cleanlyCompleted = event.reason === "completed";
  return {
    ...state,
    streamingAssistantId: null,
    streamingThinkingId: null,
    activeAgents: nextActiveAgents,
    messages: finalized,
    turnEpoch: cleanlyCompleted ? state.turnEpoch + 1 : state.turnEpoch,
    activeGoal: state.activeGoal && goalRunEnded(state.activeGoal, now() ?? Date.now()),
  };
}

export function applyErrorEvent(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "error" }>,
): MessagesReducerState {
  // Child failures are finalized in their agent_end card. A child error
  // must not stop the parent's stream or append an unrelated main error.
  if (event.agentId) return state;
  // An empty error would render as a bare "Error: " block. Drop the
  // message but still clear streaming ids (the turn is over either way).
  const errText = (event.error ?? "").trim();
  // Belt-and-braces: a user-initiated Stop can surface as an abort-flavored
  // error event (the engine now suppresses these at the source, but other
  // paths may not). The "你停止了本轮" turn_end line already covers a stop,
  // so swallow abort text instead of stacking a red Error block on top.
  const isAbort = /\b(abort|aborted|cancell?ed|interrupt)\b/i.test(errText);
  // The pointer is cleared below; seal its row first so it cannot spin on.
  const sealedThinking = sealStreamingThinking(state.messages, state.streamingThinkingId);
  return {
    ...state,
    messages:
      errText && !isAbort
        ? [...sealedThinking, { kind: "system", id: freshId("err"), text: `Error: ${errText}` }]
        : sealedThinking,
    streamingAssistantId: null,
    streamingThinkingId: null,
  };
}
