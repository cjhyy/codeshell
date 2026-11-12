import type { Message } from "../types.js";

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
  if (!userContextMsg || messages[0] !== userContextMsg) {
    return withoutDynamicContext;
  }
  return withoutDynamicContext.slice(1);
}
