import type OpenAI from "openai";
import {
  createPromptCacheKey,
  PromptCacheHistory,
  type PromptCachePolicy,
  type PromptCacheRequestContext,
} from "../prompt-cache.js";

// Clients are recreated between runs. Retain only bounded, expiring hashes;
// auxiliary purposes must never evict a main conversation's saved boundaries.
export const sharedPromptCacheHistory = new PromptCacheHistory();
export const sharedAuxPromptCacheHistory = new PromptCacheHistory();

export function prepareOpenAICacheHistory(input: {
  history: PromptCacheHistory;
  policy: PromptCachePolicy;
  request: PromptCacheRequestContext | undefined;
  scopeIdentity: Readonly<Record<string, unknown>>;
  messages: readonly OpenAI.ChatCompletionMessageParam[];
  stableBoundaryIndex: number | undefined;
  requestIdentity: () => unknown;
}) {
  const { history, policy, request, messages } = input;
  if (
    !request?.scopeId ||
    (policy.strategy !== "openai-hybrid" &&
      !(policy.strategy === "anthropic-explicit" && request.scopeKind === "auxiliary"))
  ) {
    return undefined;
  }
  let latestBoundaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      (message.role === "user" || message.role === "tool") &&
      (typeof message.content === "string"
        ? message.content.length > 0
        : Array.isArray(message.content) && message.content.length > 0)
    ) {
      latestBoundaryIndex = index;
      break;
    }
  }
  return history.prepare({
    scopeKey: createPromptCacheKey(request.scopeId, JSON.stringify(input.scopeIdentity)),
    messages,
    // Anthropic auxiliary calls always write the stable end. The rolling
    // marker may be omitted to leave room for tools and the prior read point,
    // so never remember that unsaved tail as a successful boundary.
    latestBoundaryIndex:
      policy.strategy === "anthropic-explicit"
        ? (input.stableBoundaryIndex ?? -1)
        : latestBoundaryIndex,
    stableBoundaryIndex: input.stableBoundaryIndex,
    requestIdentity: input.requestIdentity(),
  });
}
