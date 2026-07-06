/**
 * Step-gap steering queue — pure helpers over a per-session list of pending
 * user messages. Each entry carries a stable `id` so the host can (a) match the
 * later `steer_injected` event back to the queued draft it showed in the UI and
 * (b) revoke a still-pending entry via `unsteer` before the turn loop consumes
 * it. Pure + side-effect-free so it unit-tests without the Engine/TurnLoop
 * harness (same rationale as the renderer's queuedInput.ts).
 */
export interface SteerItem {
  id: string;
  text: string;
  clientMessageId?: string;
}

/** Append a steer entry. Blank text is dropped (returns the list unchanged). */
export function enqueueSteerItem(
  list: SteerItem[],
  id: string,
  text: string,
  clientMessageId?: string,
): SteerItem[] {
  const t = text?.trim();
  if (!id || !t) return list;
  return [...list, { id, text: t, ...(clientMessageId ? { clientMessageId } : {}) }];
}

/**
 * Take everything currently queued and clear the list. Returns the drained
 * entries (in order) and the now-empty remainder. The turn loop calls this at
 * each step boundary.
 */
export function consumeSteerItems(list: SteerItem[]): { drained: SteerItem[]; rest: SteerItem[] } {
  if (list.length === 0) return { drained: [], rest: [] };
  return { drained: list, rest: [] };
}

/**
 * Remove a still-pending entry by id (the 撤回 path). Returns the new list and
 * whether anything was removed — `false` means it was already consumed (the
 * host can't take it back; it has already been spliced into the run).
 */
export function removeSteerItem(
  list: SteerItem[],
  id: string,
): { list: SteerItem[]; removed: boolean } {
  const next = list.filter((item) => item.id !== id);
  return { list: next, removed: next.length !== list.length };
}
