export type QueuedInputState = Record<string, string[]>;

export function enqueueQueuedInput(
  state: QueuedInputState,
  bucket: string,
  text: string,
): QueuedInputState {
  const trimmed = text.trim();
  if (!trimmed) return state;
  return {
    ...state,
    [bucket]: [...(state[bucket] ?? []), trimmed],
  };
}

export function dequeueQueuedInput(
  state: QueuedInputState,
  bucket: string,
): { text: string | null; state: QueuedInputState } {
  const list = state[bucket] ?? [];
  if (list.length === 0) return { text: null, state };
  const [text, ...rest] = list;
  const next = { ...state };
  if (rest.length === 0) delete next[bucket];
  else next[bucket] = rest;
  return { text: text ?? null, state: next };
}

export function clearQueuedInput(state: QueuedInputState, bucket: string): QueuedInputState {
  if (!state[bucket]) return state;
  const next = { ...state };
  delete next[bucket];
  return next;
}

export function removeQueuedInputAt(
  state: QueuedInputState,
  bucket: string,
  index: number,
): QueuedInputState {
  const list = state[bucket] ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return state;
  const rest = list.filter((_item, i) => i !== index);
  const next = { ...state };
  if (rest.length === 0) delete next[bucket];
  else next[bucket] = rest;
  return next;
}

/**
 * Drain the ENTIRE queue for a bucket as one merged string (blank-line
 * separated), clearing the slot. Used by the 引导打断 path: the user wants
 * everything they queued to land in the next turn at once, not be fed one
 * message per turn (the old per-dequeue behavior left later items waiting for
 * each prior turn to finish). Returns `{ text: null }` when empty.
 */
export function drainQueuedInput(
  state: QueuedInputState,
  bucket: string,
): { text: string | null; state: QueuedInputState } {
  const list = state[bucket] ?? [];
  if (list.length === 0) return { text: null, state };
  const merged = list.join("\n\n");
  const next = { ...state };
  delete next[bucket];
  return { text: merged, state: next };
}

export function promoteQueuedInputAt(
  state: QueuedInputState,
  bucket: string,
  index: number,
): QueuedInputState {
  const list = state[bucket] ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return state;
  const item = list[index];
  if (item === undefined || index === 0) return state;
  const rest = list.filter((_queued, i) => i !== index);
  return {
    ...state,
    [bucket]: [item, ...rest],
  };
}
