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
import type { PromptCacheStrategy } from "../prompt-cache.js";

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
