import type { TokenUsage } from "../types.js";
import type { LLMUsageTracker } from "../llm/types.js";

export interface CumulativeUsageCounters {
  cumulativePromptTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeCacheCreationTokens: number;
}

export function emptyCumulativeUsageCounters(): CumulativeUsageCounters {
  return {
    cumulativePromptTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
  };
}

export function normalizeCumulativeUsageCounters(
  counters: Partial<CumulativeUsageCounters> | undefined,
  legacyUsage?: TokenUsage,
): CumulativeUsageCounters {
  return {
    cumulativePromptTokens:
      typeof counters?.cumulativePromptTokens === "number"
        ? counters.cumulativePromptTokens
        : (legacyUsage?.promptTokens ?? 0),
    cumulativeCacheReadTokens:
      typeof counters?.cumulativeCacheReadTokens === "number"
        ? counters.cumulativeCacheReadTokens
        : (legacyUsage?.cacheReadTokens ?? 0),
    cumulativeCacheCreationTokens:
      typeof counters?.cumulativeCacheCreationTokens === "number"
        ? counters.cumulativeCacheCreationTokens
        : (legacyUsage?.cacheCreationTokens ?? 0),
  };
}

export function addCumulativeUsage(
  counters: Partial<CumulativeUsageCounters> | undefined,
  usage: TokenUsage,
): CumulativeUsageCounters {
  const current = normalizeCumulativeUsageCounters(counters);
  return {
    cumulativePromptTokens: current.cumulativePromptTokens + (usage.promptTokens ?? 0),
    cumulativeCacheReadTokens: current.cumulativeCacheReadTokens + (usage.cacheReadTokens ?? 0),
    cumulativeCacheCreationTokens:
      current.cumulativeCacheCreationTokens + (usage.cacheCreationTokens ?? 0),
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + (right.promptTokens ?? 0),
    completionTokens: left.completionTokens + (right.completionTokens ?? 0),
    totalTokens: left.totalTokens + (right.totalTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheCreationTokens: (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0),
  };
}

export function cacheHitRateFromTokens(
  promptTokens: number,
  cacheReadTokens: number | undefined,
  cacheCreationTokens: number | undefined,
): number | undefined {
  const read = cacheReadTokens ?? 0;
  const creation = cacheCreationTokens ?? 0;
  if (read === 0 && creation === 0) return undefined;
  const uncached = Math.max(0, promptTokens - read - creation);
  const denom = read + creation + uncached;
  if (denom === 0) return undefined;
  return read / denom;
}

export function cacheHitRateFromUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  return cacheHitRateFromTokens(
    usage.promptTokens ?? 0,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
  );
}

export function cumulativeCacheHitRate(counters: CumulativeUsageCounters): number | undefined {
  return cacheHitRateFromTokens(
    counters.cumulativePromptTokens,
    counters.cumulativeCacheReadTokens,
    counters.cumulativeCacheCreationTokens,
  );
}

/**
 * Fold one run's cumulative usage onto a session baseline, producing the new
 * session-cumulative TokenUsage.
 *
 * The LLM client is recreated per `engine.run()`, so its `getUsage()` totals
 * count only the current run and start from zero each run. To get a true
 * session cumulative we add the run's running total onto the baseline captured
 * at run start (the value persisted from prior runs).
 *
 * Crucially this is `baseline + current`, NOT `baseline += current`: the
 * turn-boundary heartbeat fires many times within one run, each reading the
 * run's growing total. Recomputing `baseline + current` every time is
 * idempotent — it never double-counts — whereas a `+=` would add the running
 * total repeatedly. Feed the folded result back as the baseline only across
 * run boundaries (new client, fresh run total).
 */
export function foldRunUsage(baseline: TokenUsage, runUsage: LLMUsageTracker): TokenUsage {
  return {
    promptTokens: baseline.promptTokens + runUsage.totalPromptTokens,
    completionTokens: baseline.completionTokens + runUsage.totalCompletionTokens,
    totalTokens: baseline.totalTokens + runUsage.totalTokens,
    cacheReadTokens: (baseline.cacheReadTokens ?? 0) + runUsage.totalCacheReadTokens,
    cacheCreationTokens: (baseline.cacheCreationTokens ?? 0) + runUsage.totalCacheCreationTokens,
  };
}
