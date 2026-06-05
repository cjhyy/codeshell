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
