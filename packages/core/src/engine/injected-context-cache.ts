import type { Message } from "../types.js";
import { notePromptMessageLeft } from "../utils/prompt-prefix-events.js";

/**
 * Remove run-scoped context messages before caching the durable conversation:
 * the user-context head and a profile's non-durable runtime context message.
 * Context-ledger and hook-reminder messages are ordinary history and stay.
 * Identity checks are intentional: equal user-authored content must survive.
 */
export function stripInjectedContextMessages(
  messages: Message[],
  userContextMsg: Message | null,
  dynamicContextMsg: Message | null,
): Message[] {
  const withoutDynamicContext = dynamicContextMsg
    ? messages.filter((message) => message !== dynamicContextMsg)
    : [...messages];
  // The next run's requests no longer carry this run's runtime context.
  if (dynamicContextMsg && withoutDynamicContext.length < messages.length) {
    notePromptMessageLeft(dynamicContextMsg);
  }
  if (!userContextMsg || messages[0] !== userContextMsg) {
    return withoutDynamicContext;
  }
  return withoutDynamicContext.slice(1);
}
