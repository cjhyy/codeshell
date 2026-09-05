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
  | "openai-hybrid"
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
  /** GPT-5.6+ request mode; implicit also permits explicit read boundaries. */
  promptCacheOptions?: { mode: "explicit" | "implicit"; ttl: "30m" };
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
      strategy: "openai-hybrid",
      layoutVersion: "system-stable-previous-implicit-v2",
      breakpoints: OPENAI_EXPLICIT_BREAKPOINTS,
      ...(key ? { cacheKey: key } : {}),
      promptCacheOptions: { mode: "implicit", ttl: "30m" },
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

interface PromptCacheHistoryBoundary {
  index: number;
  prefixHash: string;
}

export interface PromptCacheHistoryPlan {
  scopeKey: string;
  requestOrder: number;
  /** Prior successful boundary, only when its entire request prefix still matches. */
  readBoundaryIndex?: number;
  nextBoundary?: PromptCacheHistoryBoundary;
}

/**
 * Remember one successful rolling boundary per scope, without retaining prompt
 * text. Preparing a request is read-only: failed requests must not advance the
 * boundary. The provider supplies normalized, unmarked messages and the index
 * of the latest eligible message, then commits only after a successful response.
 */
export class PromptCacheHistory {
  private readonly boundaries = new Map<
    string,
    PromptCacheHistoryBoundary & { requestOrder: number; updatedAt: number }
  >();
  private requestOrder = 0;

  constructor(
    private readonly maxScopes = 128,
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  prepare(
    input: {
      scopeKey: string;
      messages: readonly unknown[];
      latestBoundaryIndex: number;
      requestIdentity: unknown;
    },
    now = Date.now(),
  ): PromptCacheHistoryPlan {
    const plan: PromptCacheHistoryPlan = {
      scopeKey: input.scopeKey,
      requestOrder: ++this.requestOrder,
    };
    const stored = this.boundaries.get(input.scopeKey);
    const previous = stored && now - stored.updatedAt < this.ttlMs ? stored : undefined;
    // Include tools and request settings as well as message content: identical
    // history with different reasoning or tools is not the same rendered prefix.
    const hash = createHash("sha256")
      .update("codeshell-cache-history-v1\0")
      .update(JSON.stringify(input.requestIdentity) ?? "null")
      .update("\0");
    for (let index = 0; index < input.messages.length; index++) {
      hash.update(JSON.stringify(input.messages[index]) ?? "null").update("\0");
      if (index === previous?.index || index === input.latestBoundaryIndex) {
        const prefixHash = hash.copy().digest("hex");
        if (index === previous?.index && prefixHash === previous.prefixHash) {
          plan.readBoundaryIndex = index;
        }
        if (index === input.latestBoundaryIndex) {
          plan.nextBoundary = { index, prefixHash };
        }
      }
    }
    return plan;
  }

  commit(plan: PromptCacheHistoryPlan, now = Date.now()): void {
    // Concurrent requests can finish in reverse order. An older request must
    // not replace the boundary established by a newer successful request.
    if ((this.boundaries.get(plan.scopeKey)?.requestOrder ?? -1) > plan.requestOrder) return;
    this.boundaries.delete(plan.scopeKey);
    if (plan.nextBoundary && this.maxScopes > 0) {
      this.boundaries.set(plan.scopeKey, {
        ...plan.nextBoundary,
        requestOrder: plan.requestOrder,
        updatedAt: now,
      });
    }
    while (this.boundaries.size > this.maxScopes && this.boundaries.size > 0) {
      this.boundaries.delete(this.boundaries.keys().next().value!);
    }
  }
}
