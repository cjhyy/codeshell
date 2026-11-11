import { createHash } from "node:crypto";
import { resolvePromptCachePolicy } from "../llm/prompt-cache.js";
import type { LLMConfig, SessionToolSelection } from "../types.js";
import { normalizeSessionToolSelection } from "../tool-system/run-tool-surface.js";

/** Model/route identity contains no credentials and survives process restarts. */
export function toolCacheIdentity(config: LLMConfig | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config?.provider,
        config?.providerKind,
        config?.baseUrl,
        config?.model,
        config?.modelKey,
        ...(config && resolvePromptCachePolicy(config).toolDiscovery === "tool-reference"
          ? ["tool-reference-v1"]
          : []),
      ]),
    )
    .digest("hex");
}

/** A cold history may refresh schemas and promote all previously discovered tools. */
export function rebaseToolSelection(value: unknown): SessionToolSelection | undefined {
  const selection = normalizeSessionToolSelection(value);
  if (!selection) return undefined;
  const {
    frozenDefinitions: _definitions,
    deferredDefinitions: _deferred,
    behaviorToolNames: _behavior,
    lastRequestAt: _lastRequestAt,
    ...rest
  } = selection;
  return {
    ...rest,
    names: [...new Set([...selection.names, ...selection.discovered])],
    discovered: [],
  };
}

/** Match explicit request TTLs; unknown transports get a local one-day freshness ceiling. */
export function toolCacheIdleLimitMs(config: LLMConfig | undefined): number {
  const policy = config && resolvePromptCachePolicy(config);
  if (policy?.strategy === "anthropic-explicit") return 5 * 60_000;
  if (policy?.promptCacheOptions?.ttl === "30m") return 30 * 60_000;
  // Provider-managed retention is not observable. This is a local stale-schema
  // ceiling, not a claim that every compatible endpoint has a 24-hour cache TTL.
  return 24 * 60 * 60_000;
}

export function selectionForToolCacheCycle(
  value: unknown,
  identity: string,
  freshness?: { now: number; cacheVersion: string; idleLimitMs: number },
): unknown {
  const selection = normalizeSessionToolSelection(value);
  if (!selection) return value;
  const stale =
    freshness &&
    (selection.cacheVersion !== freshness.cacheVersion ||
      selection.behaviorToolNames === undefined ||
      selection.lastRequestAt === undefined ||
      selection.lastRequestAt > freshness.now ||
      freshness.now - selection.lastRequestAt >= freshness.idleLimitMs);
  return {
    ...(stale || (selection.cacheIdentity && selection.cacheIdentity !== identity)
      ? rebaseToolSelection(selection)!
      : selection),
    cacheIdentity: identity,
    ...(freshness ? { cacheVersion: freshness.cacheVersion } : {}),
  };
}

/** Do not promote discovery for a failed/no-op context cleanup. */
export function isToolCacheCompaction(info: {
  strategy: string;
  before: number;
  after: number;
  historyChanged?: boolean;
}): boolean {
  return (
    (info.historyChanged ?? info.after < info.before) &&
    ["summary", "snip", "window", "emergency", "notes", "range"].includes(info.strategy)
  );
}
