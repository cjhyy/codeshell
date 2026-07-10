/**
 * Queued composer drafts, per conversation bucket. Each entry carries a stable
 * `id` so the renderer can decouple "queued (visible, revocable)" from
 * "injected into the run (now a user bubble)": an item lives in the panel until
 * the engine's `steer_injected` event echoes its id back (removeQueuedInputById),
 * and the per-item delete button revokes it by id via the unsteer RPC.
 *
 * Pure + side-effect-free. `id` is supplied by the caller (so this stays
 * deterministic and unit-testable — no clock/random inside).
 */
import type { InputAttachmentMeta } from "../preload/types";

export interface QueuedItem {
  id: string;
  /** Engine/user-text payload. Does not include legacy attachment XML. */
  text: string;
  /** Display payload for the queue preview and eventual user bubble/title. */
  displayText?: string;
  /** Structured run attachments that must accompany this queued draft. */
  attachments?: InputAttachmentMeta[];
  clientMessageId: string;
}

export type QueuedInputState = Record<string, QueuedItem[]>;

export function canSteerQueuedItem(item: QueuedItem): boolean {
  return item.text.trim().length > 0;
}

export interface SerialTaskQueue {
  tail: Promise<void>;
}

export function enqueueSerialTask(
  queue: SerialTaskQueue,
  task: () => Promise<void> | void,
): Promise<void> {
  const run = queue.tail.catch(() => undefined).then(task);
  queue.tail = run.catch(() => undefined);
  return run;
}

export function enqueueQueuedInput(
  state: QueuedInputState,
  bucket: string,
  id: string,
  text: string,
  clientMessageId = id,
  payload: { displayText?: string; attachments?: InputAttachmentMeta[] } = {},
): QueuedInputState {
  const trimmed = text.trim();
  const displayText = (payload.displayText ?? text).trim();
  const attachments = payload.attachments?.filter(Boolean) ?? [];
  if (!id || (!trimmed && !displayText && attachments.length === 0)) return state;
  const item: QueuedItem = { id, text: trimmed, clientMessageId };
  if (displayText && displayText !== trimmed) item.displayText = displayText;
  if (attachments.length > 0) item.attachments = [...attachments];
  return {
    ...state,
    [bucket]: [...(state[bucket] ?? []), item],
  };
}

export function dequeueQueuedInput(
  state: QueuedInputState,
  bucket: string,
): { item: QueuedItem | null; state: QueuedInputState } {
  const list = state[bucket] ?? [];
  if (list.length === 0) return { item: null, state };
  const [item, ...rest] = list;
  const next = { ...state };
  if (rest.length === 0) delete next[bucket];
  else next[bucket] = rest;
  return { item: item ?? null, state: next };
}

export function clearQueuedInput(state: QueuedInputState, bucket: string): QueuedInputState {
  if (!state[bucket]) return state;
  const next = { ...state };
  delete next[bucket];
  return next;
}

/**
 * Remove the entry at `index`. Returns the new state and the removed item (so
 * the caller can unsteer it by id). `removed` is null if the index is invalid.
 */
export function removeQueuedInputAt(
  state: QueuedInputState,
  bucket: string,
  index: number,
): { state: QueuedInputState; removed: QueuedItem | null } {
  const list = state[bucket] ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return { state, removed: null };
  }
  const removed = list[index] ?? null;
  const rest = list.filter((_item, i) => i !== index);
  const next = { ...state };
  if (rest.length === 0) delete next[bucket];
  else next[bucket] = rest;
  return { state: next, removed };
}

/**
 * Remove the entry with `id` (used when the engine confirms it was injected via
 * the steer_injected event). No-op if absent (e.g. the user already deleted it).
 */
export function removeQueuedInputById(
  state: QueuedInputState,
  bucket: string,
  id: string,
): QueuedInputState {
  const list = state[bucket] ?? [];
  const rest = list.filter((item) => item.id !== id);
  if (rest.length === list.length) return state;
  const next = { ...state };
  if (rest.length === 0) delete next[bucket];
  else next[bucket] = rest;
  return next;
}

/**
 * Drain the ENTIRE queue for a bucket as one merged string (blank-line
 * separated), clearing the slot. Used by the 打断重发 path (全部引导 / forceSend):
 * everything queued lands in the next turn at once. Returns the merged text,
 * the ids that were drained, and the new state. `{ text: null, ids: [] }` when
 * empty.
 */
export function drainQueuedInput(
  state: QueuedInputState,
  bucket: string,
): {
  text: string | null;
  displayText?: string;
  attachments?: InputAttachmentMeta[];
  ids: string[];
  state: QueuedInputState;
} {
  const list = state[bucket] ?? [];
  if (list.length === 0) return { text: null, ids: [], state };
  const merged = list
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n\n");
  const displayText = list
    .map((item) => item.displayText ?? item.text)
    .filter(Boolean)
    .join("\n\n");
  const attachments = list.flatMap((item) => item.attachments ?? []);
  const ids = list.map((item) => item.id);
  const next = { ...state };
  delete next[bucket];
  return {
    text: merged,
    ...(displayText && displayText !== merged ? { displayText } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ids,
    state: next,
  };
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
