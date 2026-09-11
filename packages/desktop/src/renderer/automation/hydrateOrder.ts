/**
 * Choose the hydrate base for a session, disk-authoritative.
 *
 * disk (folded transcript.jsonl) is the complete authoritative record; local
 * (localStorage) is only a cache that may hold the not-yet-flushed tail. When
 * disk has any messages we merge (mergeTranscripts only appends the genuine
 * post-sync-point tail), so localStorage residue can't form an orphan trailing
 * group. disk empty (brand-new front-end session not yet on disk) → use local.
 */
import type { MessagesReducerState } from "../types";
import { mergeTranscripts, mergeTranscriptCursor } from "./mergeTranscripts";

export function chooseHydrateBase(
  disk: MessagesReducerState,
  local: MessagesReducerState,
): MessagesReducerState {
  return disk.messages.length > 0 ? mergeTranscripts(disk, local) : local;
}

/** Attach missing history without rewinding a live turn that arrived during the read. */
export function mergeHistoryIntoLive(
  history: MessagesReducerState,
  live: MessagesReducerState,
): MessagesReducerState {
  const merged = chooseHydrateBase(history, live);
  const liveMessages = new Map(live.messages.map((message) => [message.id, message]));
  const messages = merged.messages.map((message) => liveMessages.get(message.id) ?? message);
  // The content merge may keep the disk copy, whose generated id differs from
  // the live pointer. Retain the live object at that slot so the next delta can
  // continue it. Never infer an overlap from a short text prefix or cut away a
  // durable suffix: the live projection may itself be an older cached turn.
  const activeIds = new Set([
    live.streamingAssistantId,
    live.streamingThinkingId,
    ...Object.values(live.agentMessageIndex).map((index) => live.messages[index]?.id),
  ]);
  for (const message of live.messages) {
    if (!activeIds.has(message.id) || messages.some((item) => item.id === message.id)) continue;
    let match = -1;
    if (message.kind === "assistant" || message.kind === "thinking") {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index]!;
        if (candidate.kind === message.kind && candidate.text === message.text) {
          match = index;
          break;
        }
      }
    }
    if (match >= 0) messages[match] = message;
    else messages.push(message);
  }
  const agentMessageIndex: Record<string, number> = {};
  for (const [agentId, index] of Object.entries(live.agentMessageIndex)) {
    const messageId = live.messages[index]?.id;
    const mergedIndex = messages.findIndex((message) => message.id === messageId);
    if (mergedIndex >= 0) agentMessageIndex[agentId] = mergedIndex;
  }
  return {
    ...history,
    ...live,
    messages,
    agentMessageIndex,
    sessionId: live.sessionId ?? history.sessionId,
    promptTokens: live.promptTokens || history.promptTokens,
    cumulativePromptTokens: Math.max(history.cumulativePromptTokens, live.cumulativePromptTokens),
    cumulativeCacheReadTokens: Math.max(
      history.cumulativeCacheReadTokens,
      live.cumulativeCacheReadTokens,
    ),
    cumulativeCacheCreationTokens: Math.max(
      history.cumulativeCacheCreationTokens,
      live.cumulativeCacheCreationTokens,
    ),
    sessionPromptTokens: Math.max(history.sessionPromptTokens, live.sessionPromptTokens),
    sessionCacheReadTokens: Math.max(history.sessionCacheReadTokens, live.sessionCacheReadTokens),
    sessionCacheCreationTokens: Math.max(
      history.sessionCacheCreationTokens,
      live.sessionCacheCreationTokens,
    ),
    turnEpoch: Math.max(history.turnEpoch, live.turnEpoch),
    ...mergeTranscriptCursor(history, live),
  };
}
