import type { PetAttentionEvent, PetProjectionEvent } from "../../preload/types";

export const PET_PROJECTION_BUFFER_LIMIT = 256;
export const PET_ATTENTION_BUFFER_LIMIT = 128;
export const PET_STREAM_BUFFER_LIMIT = 500;

export function petSnapshotRetryDelay(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(Math.max(0, Math.floor(attempt)), 3));
}

/** Keep the newest events. A projection version gap will request a fresh snapshot. */
export function pushBoundedPetEvent<T>(buffer: T[], event: T, limit: number): boolean {
  buffer.push(event);
  if (buffer.length <= limit) return false;
  buffer.splice(0, buffer.length - limit);
  return true;
}

export function bufferPetProjectionEvent(
  buffer: PetProjectionEvent[],
  event: PetProjectionEvent,
): boolean {
  return pushBoundedPetEvent(buffer, event, PET_PROJECTION_BUFFER_LIMIT);
}

/**
 * Count events are snapshots of one scalar, so only the newest count matters.
 * Peek events remain ordered, with oldest entries discarded at the hard cap.
 */
export function bufferPetAttentionEvent(
  buffer: PetAttentionEvent[],
  event: PetAttentionEvent,
): boolean {
  if (event.kind === "count") {
    const previousCount = buffer.findIndex((entry) => entry.kind === "count");
    if (previousCount >= 0) buffer.splice(previousCount, 1);
  }
  return pushBoundedPetEvent(buffer, event, PET_ATTENTION_BUFFER_LIMIT);
}
