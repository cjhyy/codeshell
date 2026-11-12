/**
 * Batching gate for retroactive context rewrites.
 *
 * Providers cache request prefixes: rewriting ANY earlier message re-bills
 * everything after the nearest surviving save point. dedupeFileReads,
 * maskOldObservations and microcompact all rewrite old tool_results, so
 * running them before every model step turned a ~1k-token saving into a
 * ~310k-token cache miss. This module evaluates the three passes
 * speculatively and says when applying them — all together — is free
 * (cache already cold) or worth the miss.
 *
 * See docs/todo/prompt-cache-cross-run-context-ledger-20261112.md §3.3.
 */

import type { Message } from "../types.js";
import {
  dedupeFileReads,
  estimateTokens,
  maskOldObservations,
  microcompact,
} from "./compaction.js";

export type RewriteBatchReason = "cold" | "worth_it" | "pressure" | "hard_cap";

export interface RewriteBatchConfig {
  /** A prefix not re-read for this long is assumed evicted by the provider. */
  promptCacheTtlMs: number;
  /** Absolute floor for the "worth it" saving. */
  rewriteBatchMinSavedTokens: number;
  /** "Worth it" saving as a fraction of the un-rewritten history. */
  rewriteBatchSavedRatio: number;
}

export const DEFAULT_REWRITE_BATCH_CONFIG: RewriteBatchConfig = {
  promptCacheTtlMs: 30 * 60_000,
  rewriteBatchMinSavedTokens: 4_000,
  rewriteBatchSavedRatio: 0.15,
};

export interface RewriteBatchDecisionInput {
  now: number;
  /** Last successful model request for this session in this process. */
  lastRequestAt: number | undefined;
  promptCacheTtlMs: number;
  /** tokens(before) − tokens(after) over the whole candidate batch. */
  pendingSavedTokens: number;
  /** Tokens of the un-rewritten history. */
  totalTokens: number;
  minSavedTokens: number;
  savedRatio: number;
  /** First non-micro compaction gate (maxTokens × compactAtRatio). */
  pressureTokens: number;
  /** A member of the batch exceeds a hard request bound (e.g. image count/bytes). */
  forced?: boolean;
}

/** Why a pending batch may be applied now, or `undefined` to keep deferring. */
export function decideRewriteBatch(
  input: RewriteBatchDecisionInput,
): RewriteBatchReason | undefined {
  // A hard bound keeps the request valid for the provider; the cache yields.
  if (input.forced) return "hard_cap";
  // Cold: nothing to lose. A process that has not completed a request for
  // this session (fresh start, resume from disk) replays history anyway.
  if (input.lastRequestAt === undefined) return "cold";
  if (input.now - input.lastRequestAt > input.promptCacheTtlMs) return "cold";
  const worthIt = Math.max(input.minSavedTokens, input.savedRatio * input.totalTokens);
  if (input.pendingSavedTokens >= worthIt) return "worth_it";
  // Pressure: snip/window/summary are about to rewrite history regardless;
  // the cheap cleanup must get its chance first.
  if (input.totalTokens >= input.pressureTokens) return "pressure";
  return undefined;
}

// ─── Cache warmth, shared per session within the process ────────────

/** Bound for the registry; far above the number of live sessions in a process. */
const MAX_TRACKED_SESSIONS = 512;
const lastRequestAtBySession = new Map<string, number>();

/** Record a successful model request for `sessionKey` (monotonic). */
export function notePromptCacheRequest(sessionKey: string, at: number): void {
  const previous = lastRequestAtBySession.get(sessionKey);
  // Re-insert so iteration order is least-recently-noted first.
  lastRequestAtBySession.delete(sessionKey);
  lastRequestAtBySession.set(sessionKey, previous === undefined ? at : Math.max(previous, at));
  if (lastRequestAtBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastRequestAtBySession.keys().next().value;
    if (oldest !== undefined) lastRequestAtBySession.delete(oldest);
  }
}

export function promptCacheLastRequestAt(sessionKey: string): number | undefined {
  return lastRequestAtBySession.get(sessionKey);
}

export function resetPromptCacheWarmthForTests(): void {
  lastRequestAtBySession.clear();
}

// ─── Speculative batch ──────────────────────────────────────────────

/**
 * A retroactive rewrite owned by the caller that joins the batch, e.g. image
 * placeholders (context/image-history-window.ts). `plan` is pure; `commit` is
 * called only when the batch containing it is adopted.
 */
export interface ExternalRewrite {
  messages: Message[];
  /** A hard bound is exceeded: apply regardless of cache warmth. */
  forced: boolean;
  commit(): void;
}

export type ExternalRewritePlanner = (messages: Message[]) => ExternalRewrite | undefined;

export interface RewriteBatchPlan {
  /** Candidate history with every pending rewrite applied. */
  messages: Message[];
  /** Whether the candidate differs from the input at all. */
  changed: boolean;
  dedupedReads: number;
  maskedSnapshots: number;
  /** Set when microcompact was above its floor and cleared something. */
  micro: { clearedRounds: number; toolNames: string[]; keepRecentN: number } | undefined;
  /** Whether microcompact ran (above floor) yet freed no tokens. */
  microNoOp: boolean;
  /** Estimate entering microcompact (after dedupe + masking). */
  preMicroTokens: number;
  /** Estimate of the whole candidate. */
  candidateTokens: number;
  /** Heuristic tokens the batch would free; 0 when nothing changed. */
  savedTokens: number;
  /** Earliest message index the batch rewrites. */
  firstChangedIndex: number | undefined;
}

/**
 * Run dedupe → mask → microcompact on a candidate copy. The passes are pure;
 * the caller decides whether to adopt `messages`. `estimate` is only invoked
 * again when a pass actually changed something, so an idle step costs no
 * extra walk over the history beyond `baseTokens`.
 */
export function planRewriteBatch(
  input: Message[],
  options: {
    /** `estimate(input)`, already computed by the caller. */
    baseTokens: number;
    /** microcompact is only a candidate above this many tokens. */
    microFloorTokens: number;
    keepRecentN: number;
    estimate: (messages: Message[]) => number;
  },
): RewriteBatchPlan {
  let candidate = input;

  const dedup = dedupeFileReads(candidate);
  if (dedup.clearedCount > 0) candidate = dedup.messages;

  const masked = maskOldObservations(candidate);
  if (masked.maskedCount > 0) candidate = masked.messages;

  const preMicroTokens = candidate === input ? options.baseTokens : options.estimate(candidate);
  let candidateTokens = preMicroTokens;
  let micro: RewriteBatchPlan["micro"];
  let microNoOp = false;
  if (preMicroTokens > options.microFloorTokens) {
    let cleared: { clearedRounds: number; toolNames: string[] } | undefined;
    const compacted = microcompact(candidate, {
      keepRecentN: options.keepRecentN,
      onClear: (info) => {
        cleared = info;
      },
    });
    if (cleared) {
      candidate = compacted;
      candidateTokens = options.estimate(candidate);
      micro = { ...cleared, keepRecentN: options.keepRecentN };
    }
    microNoOp = candidateTokens === preMicroTokens;
  }

  const changed = candidate !== input;
  const diff = changed ? diffRewrittenMessages(input, candidate) : undefined;
  return {
    messages: candidate,
    changed,
    dedupedReads: dedup.clearedCount,
    maskedSnapshots: masked.maskedCount,
    micro,
    microNoOp,
    preMicroTokens,
    candidateTokens,
    savedTokens: diff?.savedTokens ?? 0,
    firstChangedIndex: diff?.firstChangedIndex,
  };
}

/**
 * Compare a history with its rewritten candidate (same length, same order).
 * The passes re-wrap untouched messages but keep untouched blocks by
 * reference, so a message changed iff one of its blocks is a new object.
 * Only changed messages are token-estimated.
 */
export function diffRewrittenMessages(
  before: Message[],
  after: Message[],
): { savedTokens: number; firstChangedIndex: number | undefined } {
  let savedTokens = 0;
  let firstChangedIndex: number | undefined;
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i];
    if (b === undefined || a === b || a.content === b.content) continue;
    if (Array.isArray(a.content) && Array.isArray(b.content)) {
      const blocks = b.content;
      if (
        a.content.length === blocks.length &&
        a.content.every((block, k) => block === blocks[k])
      ) {
        continue;
      }
    }
    firstChangedIndex ??= i;
    savedTokens += estimateTokens([a]) - estimateTokens([b]);
  }
  return { savedTokens, firstChangedIndex };
}
