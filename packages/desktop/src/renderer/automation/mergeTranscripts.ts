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
 * a fresh random id when folded from disk vs. streamed live — and because the
 * merged result is persisted back to localStorage, a re-open folds disk again
 * (new ids) while `live` still holds the previous fold's copy. Content keying
 * collapses those, so renderer-synthesized cards (files_changed,
 * context_boundary) don't accumulate one duplicate per open.
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
    case "files_changed":
      // The disk fold regenerates this card (with a fresh id) on EVERY open via
      // turn_complete, and the merged result is persisted back to localStorage,
      // so `live` carries the previous fold's stale-id copy. Keying on id let
      // the stale copy survive in the tail, accumulating one duplicate per
      // re-open. Key on content (per-file add/remove totals) so the two folds
      // collapse to one. sessionDiffs are derived from the same edits, so the
      // file totals are a sufficient identity for a single turn's card.
      return `files_changed|${m.files
        .map((f) => `${f.path}:${f.added}:${f.removed}`)
        .join(",")}`;
    case "context_boundary":
      // Same story: context_compact -> context_boundary is re-folded with a
      // fresh id each open. Key on its compaction shape instead.
      return `context_boundary|${m.strategy}|${m.before}|${m.after}`;
    default:
      // Remaining kinds (agent, task_list, ask_user) are NOT produced by the
      // disk fold — their source events (agent_start, task_update, ask) aren't
      // replayed — so they are inherently live-only. Give each a unique
      // signature so none is dropped.
      return `${m.kind}|${m.id}`;
  }
}

export function mergeTranscripts(
  disk: MessagesReducerState,
  live: MessagesReducerState,
): MessagesReducerState {
  if (disk.messages.length === 0) return live;
  if (live.messages.length === 0) return disk;

  // Find the live "continuation point": the index just after the LAST live
  // message that disk also has. Everything in live up to there is part of a
  // turn disk already covers (disk is authoritative), so we keep only what
  // comes strictly after it as the genuine tail.
  //
  // Why not a plain `filter(!seen)` (the old approach): automation now streams
  // live into the renderer too, so localStorage holds the same turn the disk
  // fold produces — PLUS live-only kinds (task_list / agent / ask_user) that
  // the disk fold never emits and that get unique kind|id signatures. A plain
  // filter kept those live-only messages even when they sat INSIDE a
  // disk-covered span, appending them as a tail with no user message; that tail
  // then folded into an orphan "已处理 N 条命令" group pinned to the bottom.
  const seen = new Set(disk.messages.map(signature));
  let lastCovered = -1;
  for (let i = 0; i < live.messages.length; i++) {
    if (seen.has(signature(live.messages[i]!))) lastCovered = i;
  }
  const liveTail = live.messages.slice(lastCovered + 1);

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
