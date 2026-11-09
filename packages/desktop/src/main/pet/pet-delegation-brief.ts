import { buildDelegationBrief, stripDelegationBrief } from "@cjhyy/code-shell-pet/disclosure";
import type { PetAutoDelegation } from "./pet-dispatch-service.js";

export { buildDelegationBrief, stripDelegationBrief };

/** agent/run's `displayText` bound (core protocol dispatch validation). */
export const MAX_DELEGATION_DISPLAY_TEXT_LENGTH = 20_000;

export interface DelegatedRunText {
  /** What the model receives. */
  task: string;
  /** What transcripts, titles, previews and the announced bubble show. */
  displayText?: string;
}

/**
 * The first message of a delegation: Mimi's brief, a blank line, then the
 * owner's objective unchanged. New and reused Sessions get it; host
 * re-drives (continuation, resume, retry) do not, since the Session already
 * has it. The brief is model-only: `displayText` keeps the owner's objective.
 */
export function delegatedRunText(
  delegation: PetAutoDelegation,
  channelLabel?: (channel: string) => string | undefined,
): DelegatedRunText {
  if (delegation.redrive) return { task: delegation.task };
  const route = delegation.completionTarget;
  let label: string | undefined;
  if (route) {
    try {
      label = channelLabel?.(route.channel);
    } catch {
      label = undefined;
    }
  }
  const brief = buildDelegationBrief(
    route ? { origin: "im", channelLabel: label || route.channel } : { origin: "desktop" },
  );
  let displayText = delegation.task.trim().slice(0, MAX_DELEGATION_DISPLAY_TEXT_LENGTH);
  // Do not split a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/u.test(displayText)) displayText = displayText.slice(0, -1);
  return {
    task: `${brief}\n\n${delegation.task}`,
    ...(displayText ? { displayText } : {}),
  };
}
