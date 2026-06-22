/**
 * patchOrphanedToolUses — repair message sequences where an assistant
 * `tool_use` block has no corresponding `tool_result`.
 *
 * Why this matters: OpenAI strictly enforces that every `tool_calls`
 * entry on an assistant message is followed by a matching `role:"tool"`
 * message (one per `tool_call_id`). An incomplete sequence triggers
 * `400 An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'`.
 *
 * The sequence can become incomplete in two ways:
 *   1. The model called tools, the API call between turns failed before
 *      the executor wrote the results. TurnLoop already patches this
 *      mid-run (see turn-loop.ts), so the broken state only lives in
 *      memory.
 *   2. The process crashed / was Ctrl+C'd after the assistant message
 *      was persisted to transcript.jsonl but before tool_result events
 *      were appended. On `/resume`, the loaded message array carries
 *      this gap into the next API call.
 *
 * This module is the resume-side counterpart: scan the entire loaded
 * history (not just the tail), find every assistant→missing-result gap,
 * inject a synthetic tool_result for each orphan in the correct
 * position so the resulting sequence is valid for both Anthropic and
 * OpenAI message shapes.
 *
 * Insertion strategy: we append the synthetic results as a NEW `user`
 * message with `tool_result` blocks placed immediately after the
 * assistant message that produced the orphan. This matches what the
 * runtime would have written if execution had completed normally, and
 * the OpenAI converter (providers/openai.ts) lifts each `tool_result`
 * out to a separate `role:"tool"` message keyed by `tool_use_id` —
 * exactly the shape the API requires.
 */

import type { ContentBlock, Message } from "../types.js";

const SYNTHETIC_ERROR_TEXT =
  "Error: Tool execution did not complete (process interrupted or earlier API failure). " +
  "This result was injected during session resume to keep the message sequence valid.";

export interface PatchOrphanedSummary {
  /** How many gaps were found across the whole history. */
  gapsPatched: number;
  /** Total synthetic tool_result blocks injected. */
  toolResultsInjected: number;
}

/**
 * Walk `messages` and, for every assistant message whose `tool_use`
 * blocks lack corresponding `tool_result`s anywhere later in the array,
 * splice a synthetic user→tool_result message right after it. Mutates
 * `messages` in place and returns a summary so callers can log how
 * much repair was needed.
 *
 * Idempotent: a second call on the same array is a no-op because the
 * first pass already filled every gap.
 */
export function patchOrphanedToolUses(messages: Message[]): PatchOrphanedSummary {
  const summary: PatchOrphanedSummary = { gapsPatched: 0, toolResultsInjected: 0 };

  // Pre-compute the set of tool_result ids already answered anywhere in
  // the history, then scan forward. Doing this in one pass avoids the
  // O(n²) "for each assistant, scan tail" pattern in TurnLoop's
  // single-shot version — resume sessions can be long.
  const answeredIds = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        answeredIds.add(block.tool_use_id);
      }
    }
  }

  // Walk left-to-right, splicing inserts immediately after the offending
  // assistant message. We iterate by index and bump past the inserted
  // message so we don't re-process it.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const orphanedIds: string[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id && !answeredIds.has(block.id)) {
        orphanedIds.push(block.id);
      }
    }
    if (orphanedIds.length === 0) continue;

    const errorBlocks: ContentBlock[] = orphanedIds.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: SYNTHETIC_ERROR_TEXT,
      // Flag as an error so the Anthropic provider marks it is_error; otherwise
      // the model reads the synthetic result as a successful tool output.
      is_error: true,
    }));
    messages.splice(i + 1, 0, { role: "user", content: errorBlocks });

    // Mark these ids answered so a later assistant message referencing
    // the same id (shouldn't happen with real id generation, but guards
    // against bad transcripts) doesn't double-patch.
    for (const id of orphanedIds) answeredIds.add(id);

    summary.gapsPatched += 1;
    summary.toolResultsInjected += orphanedIds.length;

    // Skip the synthetic message we just spliced in.
    i += 1;
  }

  return summary;
}
