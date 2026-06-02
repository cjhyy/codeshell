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
import { mergeTranscripts } from "./mergeTranscripts";

export function chooseHydrateBase(
  disk: MessagesReducerState,
  local: MessagesReducerState,
): MessagesReducerState {
  return disk.messages.length > 0 ? mergeTranscripts(disk, local) : local;
}
