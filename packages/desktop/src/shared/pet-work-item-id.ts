/**
 * Single source of truth for Mimi work-inbox item id validation, shared by the
 * main-process store (pet-work-inbox-store.ts) and the renderer cache/snapshot
 * normalizer (renderer/pet/petWorkInbox.ts). The item id embeds the structured
 * work group as its prefix (`${group}:${agentSessionId}`, or
 * `pending:${agentSessionId}:${requestId}`). Actionable follow-ups use their own
 * `follow-up:${followUpId}` namespace: handling a reminder must not implicitly
 * hide the completed source session. Keeping both contracts here prevents the
 * main and renderer boundaries from drifting apart.
 */

export const MAX_PET_WORK_INBOX_DISMISSED_ITEMS = 1_000;
export const MAX_PET_WORK_ITEM_ID_LENGTH = 512;

/**
 * Structured work groups (see renderer/pet/petWorkMap.ts PetWorkGroup), plus
 * the canonical Needs-follow-up state namespace. Follow-up ids do not represent
 * a second work-tree group; they track rows owned by PetFollowUpSection and
 * Mimi's FollowUps/ManageFollowUp capability.
 */
const PET_WORK_ITEM_ID_PATTERN = /^(?:running|pending|follow-up|completed|other):[^\u0000\r\n]+$/;

/** Durable handled/dismissed state id for one exact opaque follow-up. */
export function petFollowUpStateId(followUpId: string): string {
  return `follow-up:${followUpId}`;
}

export function isPetWorkItemId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PET_WORK_ITEM_ID_LENGTH &&
    PET_WORK_ITEM_ID_PATTERN.test(value)
  );
}
