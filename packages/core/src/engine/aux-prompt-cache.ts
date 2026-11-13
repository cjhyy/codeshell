/**
 * Prompt-cache wiring for auxiliary model calls (memory extraction, session
 * summary). These calls repeat most of their prompt on the next run of the
 * same session, but a provider only resumes from a save point at the end of a
 * message, so the repeated part is sent as its own messages with the stable
 * boundary after the last of them. See docs/todo/prompt-cache-optimization.md §五.
 */
import type { PromptCacheRequestContext, PromptCacheStrategy } from "../llm/prompt-cache.js";
import { usesExplicitCacheMarkers } from "../llm/providers/openai-cache-content.js";
import type { Message } from "../types.js";

export interface AuxPromptCachePlan {
  /** Distinguishes prompts that share no prefix, e.g. "memory-extraction". */
  purpose: string;
  /** Messages the next call repeats byte for byte, in order. */
  stable: readonly string[];
  /** Final message; free to change on every call. */
  volatile: string;
}

/**
 * Cache scope of one auxiliary purpose in one session. Never equal to the bare
 * session id, which is the main conversation's scope: boundary history and
 * provider affinity are kept per scope, and the prefixes are unrelated.
 */
export function auxPromptCacheScope(sessionId: string, purpose: string): string {
  return `${sessionId}:aux:${purpose}`;
}

/** The part of an LLM client this module reads. */
export interface AuxCacheClient {
  getPromptCacheConfigIdentity?: () => Readonly<Record<string, unknown>>;
}

/**
 * Whether the client's route places explicit cache markers. Only there does a
 * message boundary become a save point; other routes keep one message, since
 * some OpenAI-compatible backends reject consecutive user messages.
 */
function placesCacheMarkers(client: AuxCacheClient): boolean {
  const strategy = client.getPromptCacheConfigIdentity?.().cacheStrategy;
  return typeof strategy === "string" && usesExplicitCacheMarkers(strategy as PromptCacheStrategy);
}

/**
 * Request fields for an auxiliary call. Without a plan this is the single
 * user message sent before, with no cache context. With a plan the call gets
 * its own cache scope, and on marker-placing routes the stable messages are
 * sent separately with the stable boundary after the last of them.
 */
export function auxCachedRequest(input: {
  client: AuxCacheClient;
  sessionId: string;
  /** The complete prompt; equals the plan's messages concatenated. */
  prompt: string;
  plan?: AuxPromptCachePlan;
}): { messages: Message[]; promptCache?: PromptCacheRequestContext } {
  const { plan } = input;
  const whole: Message[] = [{ role: "user", content: input.prompt }];
  if (!plan) return { messages: whole };
  const scopeId = auxPromptCacheScope(input.sessionId, plan.purpose);
  const scope = { scopeId, scopeKind: "auxiliary" as const };
  const stable = plan.stable.filter((text) => text.length > 0);
  if (stable.length === 0 || plan.volatile.length === 0 || !placesCacheMarkers(input.client)) {
    return { messages: whole, promptCache: scope };
  }
  return {
    messages: [...stable, plan.volatile].map((content) => ({ role: "user", content })),
    promptCache: { ...scope, stablePrefixMessageCount: stable.length },
  };
}
