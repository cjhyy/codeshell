/**
 * Single source of truth for Mimi work-inbox item id validation, shared by the
 * main-process store (pet-work-inbox-store.ts) and the renderer cache/snapshot
 * normalizer (renderer/pet/petWorkInbox.ts). The item id embeds the structured
 * work group as its prefix (`${group}:${agentSessionId}`, or
 * `pending:${agentSessionId}:${requestId}`), so this pattern MUST stay in sync
 * with the PetWorkGroup union in renderer/pet/petWorkMap.ts. Keeping it here
 * prevents the two boundaries from drifting apart and silently dropping ids for
 * a group one side does not recognize.
 */

export const MAX_PET_WORK_INBOX_DISMISSED_ITEMS = 1_000;
export const MAX_PET_WORK_ITEM_ID_LENGTH = 512;

/** Structured work groups (see renderer/pet/petWorkMap.ts PetWorkGroup). */
const PET_WORK_ITEM_ID_PATTERN =
  /^(?:running|pending|follow-up|completed|other):[^\u0000\r\n]+$/;

export function isPetWorkItemId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PET_WORK_ITEM_ID_LENGTH &&
    PET_WORK_ITEM_ID_PATTERN.test(value)
  );
}
