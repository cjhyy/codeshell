import type { Message } from "../types.js";

/**
 * Remove run-scoped context messages before caching the durable conversation.
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
