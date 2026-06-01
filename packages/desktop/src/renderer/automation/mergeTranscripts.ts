/**
 * Merge an on-disk transcript (folded from the engine's transcript.jsonl) with
 * the renderer's localStorage transcript for the SAME session.
 *
 * Why this exists: headless automation (cron) runs persist their turns to disk
 * but never stream into the renderer, so localStorage holds at most the manual
 * follow-up turns. Opening such a session must show the headless history too.
 * The backfill importer skips sessions the UI already touched (dedup gate), so
 * the merge has to happen at session-open time.
 *
 * Strategy (see 2026-06-01 design): disk is the canonical base — it always
 * contains the complete headless history. We then append any live (localStorage)
 * messages whose content does NOT already appear in the disk fold. We dedup by
 * a content signature rather than message id, because the same logical turn gets
 * a fresh random id when folded from disk vs. streamed live.
 */
import type { Message, MessagesReducerState } from "../types";

/**
 * Content signature for dedup. Two messages with the same signature are "the
 * same turn" regardless of their (randomly assigned) ids. Tool calls key on
 * name + serialized args; text-bearing messages key on their text.
 */
function signature(m: Message): string {
  switch (m.kind) {
    case "tool":
      return `tool|${m.toolName}|${m.args}`;
    case "user":
    case "assistant":
    case "system":
    case "thinking":
      return `${m.kind}|${m.text}`;
    default:
      // Other kinds (agent, task_list, context_boundary, ask_user,
      // files_changed) don't appear in folded disk transcripts, so they are
      // inherently live-only — give each a unique signature so none is dropped.
      return `${m.kind}|${m.id}`;
  }
}

export function mergeTranscripts(
  disk: MessagesReducerState,
  live: MessagesReducerState,
): MessagesReducerState {
  if (disk.messages.length === 0) return live;
  if (live.messages.length === 0) return disk;

  const seen = new Set(disk.messages.map(signature));
  const liveTail = live.messages.filter((m) => !seen.has(signature(m)));

  return {
    ...disk,
    messages: [...disk.messages, ...liveTail],
    // Session metadata: prefer the live values (they reflect the most recent
    // session_started / usage_update), falling back to disk when live is unset.
    sessionId: live.sessionId ?? disk.sessionId,
    promptTokens: live.promptTokens || disk.promptTokens,
    // Streaming pointers belong to the live turn (if any is mid-flight).
    streamingAssistantId: live.streamingAssistantId,
    streamingThinkingId: live.streamingThinkingId,
  };
}
