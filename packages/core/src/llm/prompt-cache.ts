/**
 * Provider-neutral prompt-cache planning.
 *
 * This module owns the semantic cache policy (session affinity and reusable
 * prefix boundaries). Provider clients only translate the plan to their wire
 * format: OpenAI `prompt_cache_*` fields or Anthropic `cache_control` blocks.
 */

import { createHash } from "node:crypto";

export type PromptCacheStrategy =
  | "openai-explicit"
  | "openai-implicit"
  | "anthropic-explicit"
  | "provider-managed";

export type PromptCacheBreakpoint = "system" | "tools" | "stable-history" | "rolling-history";

export interface PromptCacheRequestContext {
  /** Stable run/session namespace used for provider cache affinity. */
  scopeId?: string;
  /**
   * Number of source messages before the first volatile context message.
   * Providers use this to retain a reusable durable-history breakpoint while
   * also advancing a rolling breakpoint over the append-only in-run tail.
   */
  stablePrefixMessageCount?: number;
}

export interface PromptCachePolicy {
  strategy: PromptCacheStrategy;
  layoutVersion: string;
  breakpoints: readonly PromptCacheBreakpoint[];
  /** Opaque and <=64 chars, as required by OpenAI's prompt_cache_key. */
  cacheKey?: string;
  /** GPT-5.6+ explicit-cache request mode. */
  promptCacheOptions?: { mode: "explicit"; ttl: "30m" };
}

export interface ResolvePromptCachePolicyInput {
  provider: string;
  providerKind?: string;
  model: string;
  request?: PromptCacheRequestContext;
  /** Sticky compatibility fallback after an endpoint rejects explicit fields. */
  explicitDisabled?: boolean;
}

const OPENAI_EXPLICIT_BREAKPOINTS = ["system", "stable-history", "rolling-history"] as const;
const ANTHROPIC_BREAKPOINTS = ["system", "tools", "stable-history", "rolling-history"] as const;
const OPENROUTER_ANTHROPIC_BREAKPOINTS = ["system", "stable-history", "rolling-history"] as const;

function normalizedModel(model: string): string {
  return model.replace(/^~/, "");
}

function isAnthropicModel(model: string): boolean {
  return /^anthropic\/claude-/i.test(normalizedModel(model));
}

function isOpenAIModel(model: string): boolean {
  const normalized = normalizedModel(model);
  return /^openai\//i.test(normalized) || /^(?:gpt-|o\d)/i.test(normalized);
}

/** GPT-5.6 and later 5.x releases support explicit prompt-cache breakpoints. */
function supportsOpenAIExplicitCaching(model: string): boolean {
  const normalized = normalizedModel(model).replace(/^openai\//i, "");
  const match = /^gpt-5\.(\d+)(?:[-.]|$)/i.exec(normalized);
  return match !== null && Number(match[1]) >= 6;
}

/**
 * Produce a privacy-preserving stable affinity key without leaking a raw
 * session id to the provider. The prefix plus 48 hex chars is 51 characters.
 */
export function createPromptCacheKey(scopeId: string, namespace: string): string {
  const digest = createHash("sha256")
    .update("codeshell-prompt-cache-v1\0")
    .update(namespace)
    .update("\0")
    .update(scopeId)
    .digest("hex")
    .slice(0, 48);
  return `cs:${digest}`;
}

/** Resolve one cache policy from the actual provider route and model family. */
export function resolvePromptCachePolicy(input: ResolvePromptCachePolicyInput): PromptCachePolicy {
  const kind = (input.providerKind ?? input.provider).toLowerCase();
  const model = normalizedModel(input.model);
  const key = input.request?.scopeId
    ? createPromptCacheKey(input.request.scopeId, `${kind}:${model}`)
    : undefined;

  if (input.provider === "anthropic" || kind === "anthropic") {
    return {
      strategy: "anthropic-explicit",
      layoutVersion: "system-tools-stable-rolling-v2",
      breakpoints: ANTHROPIC_BREAKPOINTS,
    };
  }

  if (kind === "openrouter" && isAnthropicModel(model)) {
    return {
      strategy: "anthropic-explicit",
      // OpenRouter/Anthropic includes tools in the system-prefix cache entry,
      // so a separate tool marker is unnecessary and preserves one slot.
      layoutVersion: "system-stable-rolling-v2",
      breakpoints: OPENROUTER_ANTHROPIC_BREAKPOINTS,
    };
  }

  const openAIRoute = kind === "openai" || (kind === "openrouter" && isOpenAIModel(model));
  if (openAIRoute && supportsOpenAIExplicitCaching(model) && input.explicitDisabled !== true) {
    return {
      strategy: "openai-explicit",
      layoutVersion: "system-stable-rolling-v1",
      breakpoints: OPENAI_EXPLICIT_BREAKPOINTS,
      ...(key ? { cacheKey: key } : {}),
      promptCacheOptions: { mode: "explicit", ttl: "30m" },
    };
  }

  if (openAIRoute) {
    return {
      strategy: "openai-implicit",
      layoutVersion: "implicit-affinity-v1",
      breakpoints: [],
      ...(key ? { cacheKey: key } : {}),
    };
  }

  return {
    strategy: "provider-managed",
    layoutVersion: "append-only-v1",
    breakpoints: [],
  };
}

/** Deduplicate semantic boundaries while preserving their left-to-right order. */
export function uniquePromptCacheBreakpointIndexes(
  indexes: readonly (number | undefined)[],
): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const index of indexes) {
    if (index === undefined || index < 0 || seen.has(index)) continue;
    seen.add(index);
    result.push(index);
  }
  return result;
}
