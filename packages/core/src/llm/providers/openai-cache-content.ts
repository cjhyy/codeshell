/**
 * Marker-independent content representation for OpenAI-compatible requests.
 *
 * A cache marker (`cache_control` / `prompt_cache_breakpoint`) can only ride
 * on a content part, so a marked message has to be a text-part array. If the
 * unmarked form of the same message were a plain string, the bytes of that
 * message would change whenever a breakpoint moved onto or off it — and a
 * provider resumes a cached prefix only when everything before the save point
 * is byte-identical. Probe (Claude via OpenRouter): string in one request and
 * marked array in the next lost the cache from that message on; arrays in
 * both restored a full read. See docs/todo/prompt-cache-probes-20261112.
 *
 * Under a strategy that places markers, text content is therefore always
 * sent as a text-part array. That includes assistant messages: the stable
 * boundary is the last message with content before the settled line, which
 * is usually the previous run's final answer. Strategies without markers
 * keep plain strings: some OpenAI-compatible backends reject arrays.
 */
import type OpenAI from "openai";
import type { PromptCachePolicy, PromptCacheStrategy } from "../prompt-cache.js";

export function usesExplicitCacheMarkers(strategy: PromptCacheStrategy): boolean {
  return (
    strategy === "anthropic-explicit" ||
    strategy === "openai-explicit" ||
    strategy === "openai-hybrid"
  );
}

/**
 * Lift every non-empty string content to `[{ type: "text", text }]`, in
 * place. Empty strings stay strings (an empty text part is rejected by
 * Anthropic-backed routes and is never marked), and a message without
 * content (an assistant turn that only calls tools) stays without.
 */
export function stabilizeExplicitCacheContent(
  messages: OpenAI.ChatCompletionMessageParam[],
  strategy: PromptCacheStrategy,
): void {
  if (!usesExplicitCacheMarkers(strategy)) return;
  for (const message of messages) {
    if (typeof message.content !== "string" || message.content.length === 0) continue;
    message.content = [{ type: "text", text: message.content }];
  }
}

/**
 * The policy once an endpoint rejected text-part array content. A marker can
 * only ride on a text part, so no strategy that places markers survives: the
 * route sends plain strings without markers from then on: an OpenAI route
 * keeps implicit caching and its affinity key (`openai-implicit`, as after a
 * rejected cache field), an Anthropic route is left to the provider
 * (`provider-managed`). Strategies without markers are unchanged.
 */
export function withPlainStringContent(policy: PromptCachePolicy): PromptCachePolicy {
  if (!usesExplicitCacheMarkers(policy.strategy)) return policy;
  return {
    strategy: policy.strategy === "anthropic-explicit" ? "provider-managed" : "openai-implicit",
    toolDiscovery: policy.toolDiscovery,
    layoutVersion: "plain-string-content-v1",
    breakpoints: [],
    ...(policy.cacheKey ? { cacheKey: policy.cacheKey } : {}),
  };
}

/**
 * A 400 that names message content, from a request whose text this client
 * lifted to text-part arrays: the endpoint rejects array content. Classified
 * like the cache-field fallback in openai.ts — by the request field the
 * error names — and never for an error naming a cache field, which that
 * fallback handles.
 */
export function rejectsArrayContent(status: number | undefined, message: string): boolean {
  return (
    status === 400 &&
    message.includes("messages") &&
    message.includes("content") &&
    !message.includes("prompt_cache") &&
    !message.includes("cache_control")
  );
}

/** Routes (provider, kind, model, endpoint) whose endpoint rejected text-part arrays. */
const plainStringRoutes = new Set<string>();
/** Bound on remembered routes; the oldest is forgotten first. */
const MAX_PLAIN_STRING_ROUTES = 256;

/**
 * Remember for the rest of the process that `route` accepts only string
 * content. Clients are created per run, so a later client of the same route
 * starts with plain strings instead of repeating the rejected request.
 */
export function rememberPlainStringRoute(route: string): void {
  plainStringRoutes.delete(route);
  plainStringRoutes.add(route);
  if (plainStringRoutes.size > MAX_PLAIN_STRING_ROUTES) {
    plainStringRoutes.delete(plainStringRoutes.values().next().value!);
  }
}

export function isPlainStringRoute(route: string): boolean {
  return plainStringRoutes.has(route);
}
