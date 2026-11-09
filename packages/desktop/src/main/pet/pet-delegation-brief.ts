import {
  buildCompactDelegationBrief,
  buildDelegationBrief,
  stripDelegationBrief,
  type DelegationBriefInput,
} from "@cjhyy/code-shell-pet/disclosure";
import type { PetAutoDelegation } from "./pet-dispatch-service.js";

export { buildDelegationBrief, stripDelegationBrief };

/** DelegateWork's objective bound; the brief never pushes a valid objective past it. */
export const MAX_DELEGATED_TASK_LENGTH = 8_000;

/**
 * A manager re-drive of an existing delegation ("Original objective / Latest
 * checkpoint / Necessary next step") is the only launch with a depth: that
 * Session already received the brief with its delegation's first message.
 */
export function isDelegationContinuation(delegation: PetAutoDelegation): boolean {
  return (delegation.continuationDepth ?? 0) > 0;
}

/**
 * The first message of a delegation: Mimi's brief, a blank line, then the
 * owner's objective unchanged. New Sessions and reused ones both get it.
 * When the full brief would push the message past the objective bound, the
 * one-line brief is used; when even that does not fit, the brief is omitted
 * so the objective itself is never cut.
 */
export function delegatedTaskWithBrief(
  delegation: PetAutoDelegation,
  channelLabel?: (channel: string) => string | undefined,
): string {
  if (isDelegationContinuation(delegation)) return delegation.task;
  let input: DelegationBriefInput = { origin: "desktop" };
  const route = delegation.completionTarget;
  if (route) {
    let label: string | undefined;
    try {
      label = channelLabel?.(route.channel);
    } catch {
      label = undefined;
    }
    input = { origin: "im", channelLabel: label || route.channel };
  }
  for (const brief of [buildDelegationBrief(input), buildCompactDelegationBrief(input)]) {
    const task = `${brief}\n\n${delegation.task}`;
    if (task.length <= MAX_DELEGATED_TASK_LENGTH) return task;
  }
  return delegation.task;
}
