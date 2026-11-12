/**
 * The prompt-cache route the engine plans for, as the provider actually
 * accepts it.
 *
 * An OpenAI-compatible endpoint may reject explicit cache fields; the client
 * then falls back to implicit caching (llm/providers/openai.ts). Without
 * explicit breakpoints the only save point in the history is the end of the
 * previous request, so anything planned for the explicit route — runtime
 * context at the request tail (engine/volatile-context-tail.ts), the 30-minute
 * rewrite-gate TTL (context/rewrite-gate.ts) — would cost a miss on every
 * step. Clients are created per run, so the engine remembers the fallback for
 * the rest of the process, per route.
 */
import {
  promptCacheTtlMs,
  promptCacheUsesExplicitBreakpoints,
  resolvePromptCachePolicy,
  type PromptCachePolicy,
  type PromptCacheStrategy,
} from "../llm/prompt-cache.js";
import { usesExplicitCacheMarkers } from "../llm/providers/openai-cache-content.js";
import type { LLMConfig } from "../types.js";

type RouteConfig = Pick<
  LLMConfig,
  "provider" | "providerKind" | "model" | "baseUrl" | "reasoning" | "extraBody"
>;

function routeKey(llm: RouteConfig): string {
  return JSON.stringify([llm.provider, llm.providerKind ?? "", llm.model, llm.baseUrl ?? ""]);
}

export class PromptCacheRouteMemory {
  private readonly explicitRejected = new Set<string>();

  policy(llm: RouteConfig): PromptCachePolicy {
    return resolvePromptCachePolicy({
      ...llm,
      ...(this.explicitRejected.has(routeKey(llm)) ? { explicitDisabled: true } : {}),
    });
  }

  ttlMs(llm: RouteConfig): number {
    return promptCacheTtlMs(this.policy(llm));
  }

  usesExplicitBreakpoints(llm: RouteConfig): boolean {
    return promptCacheUsesExplicitBreakpoints(this.policy(llm));
  }

  /**
   * Record the strategy a client reports after a request. Returns true when it
   * shows, for the first time, that the route dropped its explicit markers.
   */
  observe(llm: RouteConfig, effective: PromptCacheStrategy | undefined): boolean {
    if (effective === undefined || usesExplicitCacheMarkers(effective)) return false;
    const key = routeKey(llm);
    if (this.explicitRejected.has(key)) return false;
    if (!usesExplicitCacheMarkers(resolvePromptCachePolicy(llm).strategy)) return false;
    this.explicitRejected.add(key);
    return true;
  }
}
