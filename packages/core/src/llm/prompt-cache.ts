/**
 * Provider-neutral prompt-cache planning.
 *
 * This module owns the semantic cache policy (session affinity and reusable
 * prefix boundaries). Provider clients only translate the plan to their wire
 * format: OpenAI `prompt_cache_*` fields or Anthropic `cache_control` blocks.
 */

import { createHash } from "node:crypto";
import { capabilitiesForConfig } from "./capabilities/index.js";
import type { PromptCachingCapability } from "./capabilities/types.js";
import type { LLMConfig } from "../types.js";
import { nativeToolDiscoveryEnabled } from "./native-tool-discovery.js";

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
  /** How discovered tool schemas are represented in requests. */
  toolDiscovery: "call-tool" | "tool-reference";
  breakpoints: readonly PromptCacheBreakpoint[];
  /** Opaque and <=64 chars, as required by OpenAI's prompt_cache_key. */
  cacheKey?: string;
  /** GPT-5.6+ request mode; implicit also permits explicit read boundaries. */
  promptCacheOptions?: { mode: "explicit" | "implicit"; ttl: "30m" };
}

export interface ResolvePromptCachePolicyInput extends Pick<
  LLMConfig,
  "baseUrl" | "reasoning" | "extraBody"
> {
  provider: string;
  providerKind?: string;
  model: string;
  /** Resolved model capability; explicit catalog declarations take precedence. */
  promptCaching?: PromptCachingCapability;
  request?: PromptCacheRequestContext;
  /** Sticky compatibility fallback after an endpoint rejects explicit fields. */
  explicitDisabled?: boolean;
}

const OPENAI_EXPLICIT_BREAKPOINTS = ["system", "stable-history", "rolling-history"] as const;
const ANTHROPIC_BREAKPOINTS = ["system", "tools", "stable-history", "rolling-history"] as const;

function normalizedModel(model: string): string {
  return model.startsWith("~") ? model.slice(1) : model;
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
  const capability = capabilitiesForConfig(input).promptCaching;
  const toolDiscovery = nativeToolDiscoveryEnabled(input) ? "tool-reference" : "call-tool";
  const key = input.request?.scopeId
    ? createPromptCacheKey(input.request.scopeId, `${kind}:${model}`)
    : undefined;

  if (capability === "anthropic-explicit") {
    return {
      strategy: "anthropic-explicit",
      toolDiscovery,
      layoutVersion:
        toolDiscovery === "tool-reference"
          ? "system-deferred-tools-stable-rolling-v1"
          : "system-tools-stable-rolling-v2",
      breakpoints: ANTHROPIC_BREAKPOINTS,
    };
  }

  if (capability === "openai-hybrid" && input.explicitDisabled !== true) {
    return {
      strategy: "openai-hybrid",
      toolDiscovery,
      layoutVersion: "system-stable-resume-implicit-v3",
      breakpoints: OPENAI_EXPLICIT_BREAKPOINTS,
      ...(key ? { cacheKey: key } : {}),
      promptCacheOptions: { mode: "implicit", ttl: "30m" },
    };
  }

  if (capability === "openai-hybrid" || capability === "openai-implicit") {
    return {
      strategy: "openai-implicit",
      toolDiscovery,
      layoutVersion: "implicit-affinity-v1",
      breakpoints: [],
      ...(key ? { cacheKey: key } : {}),
    };
  }

  return {
    strategy: "provider-managed",
    toolDiscovery,
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
  /** Longest successful boundary whose entire request prefix still matches. */
  readBoundaryIndex?: number;
  nextBoundaries: PromptCacheHistoryBoundary[];
}

/**
 * Remember stable and rolling successful boundaries per scope without prompt
 * text. Removing a run's volatile snapshot invalidates its rolling prefix, but
 * the stable prefix before that snapshot can still be reused by the next run.
 * Preparing a request does not advance history; only successful calls commit.
 * Providers supply normalized, unmarked messages and actual wire boundary indexes.
 */
export class PromptCacheHistory {
  private readonly boundaries = new Map<
    string,
    { boundaries: PromptCacheHistoryBoundary[]; requestOrder: number; updatedAt: number }
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
      stableBoundaryIndex?: number;
      requestIdentity: unknown;
    },
    now = Date.now(),
  ): PromptCacheHistoryPlan {
    const plan: PromptCacheHistoryPlan = {
      scopeKey: input.scopeKey,
      requestOrder: ++this.requestOrder,
      nextBoundaries: [],
    };
    const stored = this.boundaries.get(input.scopeKey);
    const previous = stored && now - stored.updatedAt < this.ttlMs ? stored : undefined;
    const previousByIndex = new Map(
      previous?.boundaries.map((boundary) => [boundary.index, boundary]),
    );
    const nextIndexes = new Set(
      uniquePromptCacheBreakpointIndexes([input.stableBoundaryIndex, input.latestBoundaryIndex]),
    );
    // Include tools and request settings as well as message content: identical
    // history with different reasoning or tools is not the same rendered prefix.
    const hash = createHash("sha256")
      .update("codeshell-cache-history-v1\0")
      .update(JSON.stringify(input.requestIdentity) ?? "null")
      .update("\0");
    for (let index = 0; index < input.messages.length; index++) {
      hash.update(JSON.stringify(input.messages[index]) ?? "null").update("\0");
      if (previousByIndex.has(index) || nextIndexes.has(index)) {
        const prefixHash = hash.copy().digest("hex");
        if (prefixHash === previousByIndex.get(index)?.prefixHash) {
          plan.readBoundaryIndex = index;
        }
        if (nextIndexes.has(index)) {
          plan.nextBoundaries.push({ index, prefixHash });
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
    if (this.maxScopes > 0) {
      this.boundaries.set(plan.scopeKey, {
        boundaries: plan.nextBoundaries.map((boundary) => ({ ...boundary })),
        requestOrder: plan.requestOrder,
        updatedAt: now,
      });
    }
    while (this.boundaries.size > this.maxScopes && this.boundaries.size > 0) {
      this.boundaries.delete(this.boundaries.keys().next().value!);
    }
  }
}
