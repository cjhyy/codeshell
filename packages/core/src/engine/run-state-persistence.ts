import { isDeepStrictEqual } from "node:util";
import type { SessionState, StreamEvent, TokenUsage } from "../types.js";
import type { SessionManager, SessionStateFieldPatch } from "../session/session-manager.js";
import {
  addCumulativeUsage,
  addTokenUsage,
  cumulativeCacheHitRate,
  normalizeCumulativeUsageCounters,
} from "../session/usage.js";

/** Publish the exact cumulative snapshot which won a state commit. */
export function sessionCumulativeUsageUpdate(state: SessionState): StreamEvent {
  const cumulative = normalizeCumulativeUsageCounters(state, state.tokenUsage);
  const hitRate = cumulativeCacheHitRate(cumulative);
  return {
    type: "usage_update",
    promptTokens: cumulative.cumulativePromptTokens,
    promptTokensSource: "session_cumulative",
    promptTokensConfidence: "high",
    ...cumulative,
    ...(hitRate !== undefined ? { cumulativeCacheHitRate: hitRate } : {}),
    sessionPromptTokens: cumulative.cumulativePromptTokens,
    sessionCacheReadTokens: cumulative.cumulativeCacheReadTokens,
    sessionCacheCreationTokens: cumulative.cumulativeCacheCreationTokens,
  };
}

/** Private accounting checkpoint for one concrete Engine run. */
export interface RunningSessionState {
  sessionId: string;
  runId: string;
  state: SessionState;
  committedUsage: TokenUsage;
  committedCacheUsage: TokenUsage;
  committedAnchor: SessionState["contextUsageAnchor"];
  finalized: boolean;
  ownUsage?: () => TokenUsage;
  ownCacheUsage?: () => TokenUsage;
}

/** Merge only this run's uncommitted usage, preserving other owners' durable additions. */
export function persistRunState(args: {
  manager: SessionManager;
  state: SessionState;
  fields: SessionStateFieldPatch;
  runId?: string;
  running?: RunningSessionState;
  costState: () => Record<string, unknown>;
}): boolean {
  const { manager, state, fields, runId, running, costState } = args;
  // Detached manual-compaction bundles keep their existing field-writer contract.
  if (running?.state !== state) {
    return manager.saveStateOrUpdateFields(state, fields, runId);
  }
  if (runId !== running.runId) return false;
  const capturedUsage = structuredClone(
    running.ownUsage?.() ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  const delta = subtractUsage(capturedUsage, running.committedUsage);
  const capturedCacheUsage = structuredClone(
    running.ownCacheUsage?.() ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
  const cacheDelta = subtractUsage(capturedCacheUsage, running.committedCacheUsage);
  if (
    [...Object.values(delta), ...Object.values(cacheDelta)].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    return false;
  const previousAnchor = structuredClone(running.committedAnchor);
  let committedFields: SessionStateFieldPatch | undefined;
  try {
    const stateRevision = manager.updateSessionRunState(state.sessionId, runId, (latest) => {
      // Every CAS attempt uses the same captured own delta but fresh durable
      // counters and receipts. A failed attempt never advances the checkpoint.
      committedFields = {
        ...fields,
        tokenUsage: addTokenUsage(latest.tokenUsage, delta),
        ...addCumulativeUsage(
          normalizeCumulativeUsageCounters(latest, latest.tokenUsage),
          cacheDelta,
        ),
        contextUsageAnchor: isDeepStrictEqual(latest.contextUsageAnchor, previousAnchor)
          ? fields.contextUsageAnchor
          : latest.contextUsageAnchor,
        costState: costState(),
      };
      return committedFields;
    });
    Object.assign(state, committedFields, { stateRevision });
    running.committedUsage = capturedUsage;
    running.committedCacheUsage = capturedCacheUsage;
    running.committedAnchor = structuredClone(state.contextUsageAnchor);
    return true;
  } catch {
    return false;
  }
}

/** Separate checkpoints keep billed auxiliary input out of foreground cache deltas. */
export function subtractUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return {
    promptTokens: current.promptTokens - previous.promptTokens,
    completionTokens: current.completionTokens - previous.completionTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) - (previous.cacheReadTokens ?? 0),
    cacheCreationTokens: (current.cacheCreationTokens ?? 0) - (previous.cacheCreationTokens ?? 0),
  };
}
