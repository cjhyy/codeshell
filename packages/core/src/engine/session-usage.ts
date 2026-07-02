import type { TokenUsage } from "../types.js";
import type { LLMUsageTracker } from "../llm/types.js";

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
    cacheCreationTokens:
      (baseline.cacheCreationTokens ?? 0) + runUsage.totalCacheCreationTokens,
  };
}
