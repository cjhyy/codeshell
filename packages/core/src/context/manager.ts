/**
 * Context manager — three-tier context management.
 *
 * Tier 1: microcompact (sync, zero-cost) — clear old tool_result content
 * Tier 2: LLM summary (async) — generate summary of older messages via model call
 * Tier 3: window compact (sync, emergency) — aggressive truncation fallback
 */

import type { Message, LLMResponse, ContextUsageAnchor } from "../types.js";
import {
  estimateTokens,
  microcompact,
  dedupeFileReads,
  maskOldObservations,
  snipCompact,
  windowCompact,
  truncateToolResult,
  buildSummarizationPrompt,
  applySummaryCompaction,
  applyToolResultBudget,
  extractAnchoredSummary,
} from "./compaction.js";
import {
  type ContentReplacementState,
  applyToolResultPersistence,
  createContentReplacementState,
  reconstructContentReplacementState,
  resolveToolResultsDir,
} from "./tool-result-storage.js";
import { logger } from "../logging/logger.js";

export interface ContextManagerConfig {
  maxTokens: number;
  compactAtRatio: number;
  summarizeAtRatio: number;
  maxToolResultChars: number;
  /**
   * Lower bound, as a ratio of maxTokens, below which microcompact will not
   * run. CC's external (non-cache-edit) path is "autocompact handles context
   * pressure"; mirror that by leaving early-turn context alone so a model
   * with a 1M window doesn't see its first-3-rounds Read results wiped at
   * 23k tokens. Raising the floor also keeps prompt-cache prefixes warm in
   * short sessions.
   */
  microcompactFloorRatio: number;
  /**
   * Most-recent compactable rounds microcompact keeps untouched. Auto-derived
   * from maxTokens when not set explicitly: bigger window → keep more.
   */
  microcompactKeepRecent?: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  // 0.85 ≈ effectiveContextWindow − reserved-output buffer (CC's
  // autoCompactThreshold pattern: window − 13k buffer − 20k output budget
  // ≈ 0.83 on a 200k window, 0.97 on 1M). 0.6 was wasting 40% of any model
  // with a window over ~150k.
  maxTokens: 200_000,
  compactAtRatio: 0.85,
  summarizeAtRatio: 0.92,
  maxToolResultChars: 30_000,
  // 0.7 leaves micro idle until the prompt is ~70% full. Below this we
  // let tool_results stay intact: under-pressure context doesn't need
  // micro and wiping early Read/Bash output just forces the model to
  // re-fetch the same files later. CC's external path triggers around
  // 70-75% of the window; this matches it. Was 0.5 — on a 200k model
  // that fired at 100k where a long-but-not-overloaded conversation
  // (~130k tokens) tripped micro every single turn, with the cleared
  // 8 rounds promptly replaced by 5 fresh ones so the next turn was
  // back at 130k and the cycle repeated. 0.7 → 140k floor, leaving
  // realistic headroom before we start churning.
  microcompactFloorRatio: 0.7,
};

/**
 * Default keepRecent for microcompact, scaled to the model's context window.
 * Mirrors CC's "keep recent 5" baseline but lets a 1M-window model retain
 * proportionally more tool_result detail before clearing kicks in.
 */
function defaultKeepRecent(maxTokens: number): number {
  return Math.max(5, Math.floor(maxTokens / 100_000));
}

/**
 * Async function type for LLM summarization calls.
 * Injected by the Engine so the ContextManager doesn't depend on LLM directly.
 */
export type SummarizeFn = (prompt: string) => Promise<string>;

export type CompactStrategy = "micro" | "summary" | "window" | "snip" | "emergency";
export type OnCompactFn = (info: {
  strategy: CompactStrategy;
  before: number;
  after: number;
}) => void;
type SummaryCompactLogEvent = "context.summary_compact" | "context.force_summary_compact";
type SummaryCompactResult = {
  messages: Message[];
  tokens: number;
  compacted: boolean;
  noProgress: boolean;
};

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export class ContextManager {
  private config: ContextManagerConfig;
  private summarizeFn: SummarizeFn | undefined;
  private consecutiveSummaryFailures = 0;
  /** Prevents repeated spin-band LLM calls after a summary generated no shrink. */
  private suppressNoOpMicroSummaryUntilCompact = false;
  private lastSummary: string | undefined;
  /** Last known actual token count from API usage data. */
  private lastActualTokens: number | undefined;
  /** Message count at the time lastActualTokens was recorded. */
  private lastActualAtMessageCount: number | undefined;
  /** Heuristic token estimate for the same messages as lastActualTokens. */
  private lastActualAnchorEstimate: number | undefined;
  private lastActualRecordedAt: number | undefined;
  private lastActualProvider: string | undefined;
  private lastActualModel: string | undefined;
  /** Path to session transcript — passed to summary compaction for on-demand access. */
  private transcriptPath: string | undefined;
  /** Notified whenever any compaction tier fires, including microcompact. */
  private onCompact: OnCompactFn | undefined;
  /**
   * Tool-result persistence state. Created lazily once we know where to
   * write files (i.e. once setTranscriptPath has been called).
   * `null` = persistence has been explicitly disabled.
   */
  private replacementState: ContentReplacementState | undefined;
  private toolResultsDir: string | undefined;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setOnCompact(fn: OnCompactFn): void {
    this.onCompact = fn;
  }

  /**
   * Record actual token usage from API response.
   * Used for hybrid estimation: actual + estimate for new messages.
   */
  recordActualUsage(
    inputTokens: number,
    messageCount: number,
    messages?: Message[],
  ): ContextUsageAnchor | undefined {
    const estimateAtAnchor = messages ? estimateTokens(messages) : undefined;
    return this.seedActualUsage({
      promptTokens: inputTokens,
      messageCount,
      ...(estimateAtAnchor !== undefined ? { estimateAtAnchor } : {}),
      recordedAt: Date.now(),
    });
  }

  /**
   * Seed actual prompt-token usage from persisted session state.
   * Returns the normalized anchor when accepted; invalid legacy/tampered data is ignored.
   */
  seedActualUsage(anchor: ContextUsageAnchor | undefined): ContextUsageAnchor | undefined {
    if (!anchor) return undefined;
    if (!positiveFinite(anchor.promptTokens)) return undefined;
    if (!Number.isSafeInteger(anchor.messageCount) || anchor.messageCount <= 0) {
      return undefined;
    }
    if (anchor.estimateAtAnchor !== undefined && !positiveFinite(anchor.estimateAtAnchor)) {
      return undefined;
    }

    this.lastActualTokens = anchor.promptTokens;
    this.lastActualAtMessageCount = anchor.messageCount;
    this.lastActualAnchorEstimate = anchor.estimateAtAnchor;
    this.lastActualRecordedAt = positiveFinite(anchor.recordedAt) ? anchor.recordedAt : Date.now();
    this.lastActualProvider = anchor.provider;
    this.lastActualModel = anchor.model;

    return this.getActualUsageAnchor();
  }

  getActualUsageAnchor(): ContextUsageAnchor | undefined {
    if (
      this.lastActualTokens === undefined ||
      this.lastActualAtMessageCount === undefined ||
      this.lastActualRecordedAt === undefined
    ) {
      return undefined;
    }
    return {
      promptTokens: this.lastActualTokens,
      messageCount: this.lastActualAtMessageCount,
      ...(this.lastActualAnchorEstimate !== undefined
        ? { estimateAtAnchor: this.lastActualAnchorEstimate }
        : {}),
      recordedAt: this.lastActualRecordedAt,
      ...(this.lastActualProvider ? { provider: this.lastActualProvider } : {}),
      ...(this.lastActualModel ? { model: this.lastActualModel } : {}),
    };
  }

  /**
   * Best-effort token estimate: uses actual API usage as base if available,
   * plus estimation for messages added since the last API call.
   */
  private estimateTokensHybrid(messages: Message[]): number {
    const currentEstimate = estimateTokens(messages);
    if (
      this.lastActualTokens !== undefined &&
      this.lastActualAtMessageCount !== undefined
    ) {
      if (this.lastActualAtMessageCount < messages.length) {
        const newMessages = messages.slice(this.lastActualAtMessageCount);
        const newTokens = estimateTokens(newMessages);
        return this.lastActualTokens + newTokens;
      }

      if (this.lastActualAnchorEstimate !== undefined && this.lastActualAnchorEstimate > 0) {
        return Math.round(
          this.lastActualTokens * (currentEstimate / this.lastActualAnchorEstimate),
        );
      }
    }
    return currentEstimate;
  }

  /**
   * Set the summarize function (injected by Engine).
   */
  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn;
  }

  private async trySummaryCompact(
    messages: Message[],
    before: number,
    logEvent: SummaryCompactLogEvent,
  ): Promise<SummaryCompactResult> {
    if (!this.summarizeFn || this.consecutiveSummaryFailures >= 3) {
      return { messages, tokens: before, compacted: false, noProgress: false };
    }

    try {
      const keepRecentN = Math.max(8, Math.floor(messages.length * 0.3));
      const messagesToSummarize = messages.slice(1, -keepRecentN); // skip first (userContext) and recent

      if (messagesToSummarize.length <= 3) {
        return { messages, tokens: before, compacted: false, noProgress: false };
      }

      // Rolling summary: if a prior summary is already anchored in the
      // messages (from an earlier compaction in this session or in a resumed
      // session), feed it back so the LLM merges-updates rather than
      // re-summarizes from scratch.
      const priorSummary = extractAnchoredSummary(messages) ?? this.lastSummary;
      const prompt = buildSummarizationPrompt(messagesToSummarize, priorSummary);
      const summary = await this.summarizeFn(prompt);

      if (!summary || summary.length <= 50) {
        this.consecutiveSummaryFailures++;
        logger.warn("context.summary_failed", {
          failures: this.consecutiveSummaryFailures,
          error: "summary was empty or too short",
        });
        return { messages, tokens: before, compacted: false, noProgress: true };
      }

      const compacted = applySummaryCompaction(
        messages,
        summary,
        keepRecentN,
        this.transcriptPath,
      );
      const after = this.estimateTokensHybrid(compacted);

      if (after >= before) {
        this.consecutiveSummaryFailures++;
        logger.warn("context.summary_no_progress", {
          failures: this.consecutiveSummaryFailures,
          before,
          after,
          summaryLen: summary.length,
          rolling: priorSummary !== undefined,
        });
        return { messages, tokens: before, compacted: false, noProgress: true };
      }

      this.consecutiveSummaryFailures = 0;
      this.lastSummary = summary;
      logger.info(logEvent, {
        before,
        after,
        summaryLen: summary.length,
        rolling: priorSummary !== undefined,
      });
      this.onCompact?.({ strategy: "summary", before, after });
      return { messages: compacted, tokens: after, compacted: true, noProgress: false };
    } catch (err) {
      this.consecutiveSummaryFailures++;
      logger.warn("context.summary_failed", {
        failures: this.consecutiveSummaryFailures,
        error: (err as Error).message,
      });
      return { messages, tokens: before, compacted: false, noProgress: false };
    }
  }

  /**
   * Set the transcript path so compaction can reference it. The
   * tool-results directory lives alongside the transcript file:
   *   <transcriptDir>/tool-results/<toolUseId>.txt
   */
  setTranscriptPath(path: string): void {
    this.transcriptPath = path;
    this.toolResultsDir = resolveToolResultsDir(path);
  }

  /**
   * Initialize tool-result-persistence state from already-loaded messages.
   * Call this once per session, after setTranscriptPath, when resuming so
   * the manager re-enters the same "frozen decision" state it had on the
   * previous run. Without this, a resumed session would re-evaluate
   * every result against the current threshold and might flip choices.
   */
  initReplacementStateFromMessages(messages: Message[]): void {
    this.replacementState = reconstructContentReplacementState(messages);
  }

  /**
   * Apply progressive context management (sync path).
   * For Tier 2 (LLM summary), call manageAsync instead.
   */
  manage(messages: Message[]): Message[] {
    let result = messages;

    // Tier 0a: Persist large tool_results to disk + replace with preview.
    // Runs before any in-context truncation so the model gets a real
    // filepath it can Read back, not a silent head/tail truncation.
    result = this.persistLargeToolResults(result);

    // Tier 0b: Hard truncate any oversized tool_result that survived
    // persistence (e.g. persistence disabled, FS write failed, or a
    // block was already frozen "don't persist" on a prior pass).
    result = this.truncateToolResults(result);

    // Tier 0c: Aggregate tool result budget (per-message) — char-level
    // backstop for messages still over the limit after persistence.
    result = applyToolResultBudget(result);

    // Tier 0d: dedup repeated Reads of the same file — keep only the latest
    // copy (older ones are stale). Always-on + zero-cost: it's pure waste
    // removal (the model never needs two snapshots of one file), unlike the
    // pressure-/recency-gated tiers below. Runs before microcompact so an
    // already-deduped result isn't double-counted toward the keep-recent window.
    const dedup = dedupeFileReads(result);
    if (dedup.clearedCount > 0) {
      result = dedup.messages;
      logger.info("context.dedupe_file_reads", { cleared: dedup.clearedCount });
    }

    // Tier 0d': browser observation masking — keep only the latest
    // browser_snapshot, collapse older ones (stale element lists, often large).
    // Same always-on waste-removal class as dedupeFileReads. The research's
    // top browser-token lever (folding old observations beats LLM summarizing).
    const masked = maskOldObservations(result);
    if (masked.maskedCount > 0) {
      result = masked.messages;
      logger.info("context.mask_browser_snapshots", { masked: masked.maskedCount });
    }

    // Tier 1: microcompact — fingerprint old whitelisted tool_results.
    // Only runs above the floor ratio: under-pressure context keeps full
    // detail so the model isn't forced to re-Read files it just looked at.
    const preTier1Tokens = this.estimateTokensHybrid(result);
    if (preTier1Tokens > this.config.maxTokens * this.config.microcompactFloorRatio) {
      const keepRecentN =
        this.config.microcompactKeepRecent ?? defaultKeepRecent(this.config.maxTokens);
      // Capture rounds/tools synchronously from microcompact's onClear, but
      // defer the token re-estimate until AFTER `result` has been reassigned
      // to the compacted array — onClear fires before microcompact returns,
      // so reading `result` inside it would see the pre-compact reference.
      let clearedInfo: { clearedRounds: number; toolNames: string[] } | null = null;
      result = microcompact(result, {
        keepRecentN,
        onClear: (info) => {
          clearedInfo = info;
        },
      });
      if (clearedInfo) {
        const after = this.estimateTokensHybrid(result);
        logger.info("context.microcompact", {
          before: preTier1Tokens,
          after,
          keepRecentN,
          clearedRounds: (clearedInfo as { clearedRounds: number }).clearedRounds,
          toolNames: (clearedInfo as { toolNames: string[] }).toolNames,
        });
        this.onCompact?.({ strategy: "micro", before: preTier1Tokens, after });
      }
    }

    // Hybrid token estimation walks every message; we cache it across the
    // tier checks below and only recompute after a compaction shrinks `result`.
    let tokens = this.estimateTokensHybrid(result);

    // Tiers run in increasing severity. Each tier short-circuits its own
    // arm but the next tier still runs if we're still above the next gate
    // — a single pass can escalate micro → summary-replay → snip → window
    //  → emergency when the model just dumped a flood of tool_results.
    //
    // Severity gates (fractions of maxTokens):
    //   compactAtRatio       — start non-micro compaction (try summary first,
    //                          else snip; snip is the cheapest sync option)
    //   compactAtRatio + 0.05 — snip wasn't enough, do a window compact
    //   summarizeAtRatio      — emergency window (smallest keep-tail)
    const snipGate = this.config.maxTokens * this.config.compactAtRatio;
    const windowGate = this.config.maxTokens * (this.config.compactAtRatio + 0.05);
    const emergencyGate = this.config.maxTokens * this.config.summarizeAtRatio;

    // Tier 2: prefer replaying a cached summary; otherwise snip
    if (tokens > snipGate) {
      const before = tokens;
      if (this.lastSummary) {
        const keepN = Math.max(8, Math.floor(result.length * 0.3));
        result = applySummaryCompaction(result, this.lastSummary, keepN, this.transcriptPath);
        this.lastSummary = undefined;
        tokens = this.estimateTokensHybrid(result);
        this.onCompact?.({ strategy: "summary", before, after: tokens });
      } else {
        result = snipCompact(result, 3, 8);
        tokens = this.estimateTokensHybrid(result);
        this.onCompact?.({ strategy: "snip", before, after: tokens });
      }
    }

    // Tier 2b: snip didn't free enough — fall back to window compact
    if (tokens > windowGate) {
      const before = tokens;
      const keepN = Math.max(10, Math.floor(result.length * 0.4));
      result = windowCompact(result, keepN);
      tokens = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "window", before, after: tokens });
    }

    // Tier 3: emergency window with a tiny tail — last resort before the
    // request would otherwise blow the model's context.
    if (tokens > emergencyGate) {
      const before = tokens;
      result = windowCompact(result, 6);
      tokens = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "emergency", before, after: tokens });
    }

    return result;
  }

  /**
   * Async context management — attempts LLM summarization before falling back.
   * Call this when you have access to the LLM (between turns).
   */
  async manageAsync(messages: Message[]): Promise<Message[]> {
    let result = messages;

    // Tier 0a: Persist large tool_results to disk + replace with preview.
    result = this.persistLargeToolResults(result);

    // Tier 0b: Hard truncate oversized tool_result blocks that weren't
    // persisted (persistence disabled, FS error, or already frozen).
    result = this.truncateToolResults(result);

    // Tier 0c: Aggregate tool result budget (per-message)
    result = applyToolResultBudget(result);

    // Tier 0d: same always-on waste-removal passes as manage().
    const dedup = dedupeFileReads(result);
    if (dedup.clearedCount > 0) {
      result = dedup.messages;
      logger.info("context.dedupe_file_reads", { cleared: dedup.clearedCount });
    }

    const masked = maskOldObservations(result);
    if (masked.maskedCount > 0) {
      result = masked.messages;
      logger.info("context.mask_browser_snapshots", { masked: masked.maskedCount });
    }

    // Tier 1: microcompact — see manage() for the rationale on the floor.
    const preTier1Tokens = this.estimateTokensHybrid(result);
    const microFloorGate = this.config.maxTokens * this.config.microcompactFloorRatio;
    let microNoOpAtFloor = false;
    if (preTier1Tokens > microFloorGate) {
      const keepRecentN =
        this.config.microcompactKeepRecent ?? defaultKeepRecent(this.config.maxTokens);
      // See manage(): onClear fires synchronously before microcompact returns,
      // so defer the token re-estimate until result is reassigned.
      let clearedInfo: { clearedRounds: number; toolNames: string[] } | null = null;
      result = microcompact(result, {
        keepRecentN,
        onClear: (info) => {
          clearedInfo = info;
        },
      });
      const postTier1Tokens = this.estimateTokensHybrid(result);
      microNoOpAtFloor = postTier1Tokens === preTier1Tokens;
      if (postTier1Tokens < preTier1Tokens) {
        this.suppressNoOpMicroSummaryUntilCompact = false;
      }
      if (clearedInfo) {
        logger.info("context.microcompact", {
          before: preTier1Tokens,
          after: postTier1Tokens,
          keepRecentN,
          clearedRounds: (clearedInfo as { clearedRounds: number }).clearedRounds,
          toolNames: (clearedInfo as { toolNames: string[] }).toolNames,
        });
        this.onCompact?.({
          strategy: "micro",
          before: preTier1Tokens,
          after: postTier1Tokens,
        });
      }
    }

    let tokens = this.estimateTokensHybrid(result);
    const ratio = tokens / this.config.maxTokens;
    if (ratio < this.config.microcompactFloorRatio) {
      this.suppressNoOpMicroSummaryUntilCompact = false;
    }
    const noOpMicroSpinBand =
      microNoOpAtFloor &&
      ratio >= this.config.microcompactFloorRatio &&
      ratio < this.config.compactAtRatio;
    const shouldEscalateNoOpMicro =
      noOpMicroSpinBand && !this.suppressNoOpMicroSummaryUntilCompact;
    const snipGate = this.config.maxTokens * this.config.compactAtRatio;
    const windowGate = this.config.maxTokens * (this.config.compactAtRatio + 0.05);
    const emergencyGate = this.config.maxTokens * this.config.summarizeAtRatio;

    // Tier 2: LLM summary if approaching limit, or if micro was the only tier
    // available in the 0.70-0.85 band and it freed nothing.
    if (ratio >= this.config.compactAtRatio || shouldEscalateNoOpMicro) {
      const summarized = await this.trySummaryCompact(
        result,
        tokens,
        "context.summary_compact",
      );
      result = summarized.messages;
      tokens = summarized.tokens;

      if (summarized.compacted) {
        this.suppressNoOpMicroSummaryUntilCompact = false;
        if (tokens <= snipGate) return result;
      }

      if (shouldEscalateNoOpMicro && summarized.noProgress) {
        this.suppressNoOpMicroSummaryUntilCompact = true;
        logger.info("context.micro_noop_summary_suppressed", {
          tokens,
          ratio,
          compactAtRatio: this.config.compactAtRatio,
          microcompactFloorRatio: this.config.microcompactFloorRatio,
        });
      }
    }

    // Reuse the `tokens` we already computed above. We get here if no summary
    // compacted the prompt, or if summary helped but the hybrid estimate is
    // still above the fallback gate.
    let live = tokens;

    // Tier 2 fallback: snip first (cheapest sync option)
    if (live > snipGate) {
      const before = live;
      result = snipCompact(result, 3, 8);
      live = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "snip", before, after: live });
    }

    // Tier 2b: window compact when snip didn't free enough
    if (live > windowGate) {
      const before = live;
      const keepN = Math.max(10, Math.floor(result.length * 0.4));
      result = windowCompact(result, keepN);
      live = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "window", before, after: live });
    }

    // Tier 3: Emergency
    if (live > emergencyGate) {
      const before = live;
      result = windowCompact(result, 6);
      live = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "emergency", before, after: live });
    }

    return result;
  }

  /**
   * Force maximum compaction, ignoring the ratio gates. This is what a manual
   * `/compact` invokes: the user explicitly asked to shrink NOW, so we don't
   * wait for the prompt to reach compactAtRatio.
   *
   * Order: tier-0 cleanups (persist/truncate/dedupe/mask) + microcompact, then
   * an unconditional LLM summary of the older messages. If no summarizeFn is
   * wired (or it fails / yields nothing), fall back to snip → window so the
   * call still shrinks the conversation rather than no-opping.
   *
   * Unlike manage()/manageAsync(), there is NO `ratio >= compactAtRatio` gate:
   * a long-but-under-threshold text-only conversation (the /compact bug) still
   * gets summarized here.
   */
  async forceSummarize(messages: Message[]): Promise<Message[]> {
    let result = messages;

    // Tier 0: same waste-removal + micro as the automatic path.
    result = this.persistLargeToolResults(result);
    result = this.truncateToolResults(result);
    result = applyToolResultBudget(result);
    const dedup = dedupeFileReads(result);
    if (dedup.clearedCount > 0) result = dedup.messages;
    const masked = maskOldObservations(result);
    if (masked.maskedCount > 0) result = masked.messages;

    const keepRecentN =
      this.config.microcompactKeepRecent ?? defaultKeepRecent(this.config.maxTokens);
    result = microcompact(result, { keepRecentN });

    let tokens = this.estimateTokensHybrid(result);

    // Unconditional LLM summary (no ratio gate).
    {
      const summarized = await this.trySummaryCompact(
        result,
        tokens,
        "context.force_summary_compact",
      );
      result = summarized.messages;
      tokens = summarized.tokens;
      if (summarized.compacted) return result;
    }

    // Fallback: no summary available — snip, then window, so /compact still
    // shrinks the conversation instead of no-opping.
    {
      const before = tokens;
      result = snipCompact(result, 3, 8);
      tokens = this.estimateTokensHybrid(result);
      if (tokens < before) this.onCompact?.({ strategy: "snip", before, after: tokens });
    }
    if (this.estimateTokensHybrid(result) >= this.estimateTokensHybrid(messages)) {
      const before = tokens;
      const keepN = Math.max(10, Math.floor(result.length * 0.4));
      result = windowCompact(result, keepN);
      tokens = this.estimateTokensHybrid(result);
      this.onCompact?.({ strategy: "window", before, after: tokens });
    }

    return result;
  }

  /**
   * Persist large tool_result blocks to disk and replace them with a
   * preview + filepath. No-op when transcript path hasn't been set
   * (e.g. unit tests that exercise compaction directly without a session).
   */
  private persistLargeToolResults(messages: Message[]): Message[] {
    if (!this.toolResultsDir) return messages;
    if (!this.replacementState) {
      this.replacementState = createContentReplacementState();
    }
    return applyToolResultPersistence(messages, {
      toolResultsDir: this.toolResultsDir,
      state: this.replacementState,
      onPersist: (info) => {
        logger.info("context.tool_result_persisted", info);
      },
    });
  }

  /**
   * Truncate oversized tool results in messages.
   */
  private truncateToolResults(messages: Message[]): Message[] {
    const maxChars = this.config.maxToolResultChars;

    const result = messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;

      // Per-message flag: a truncation in an earlier message must not force
      // later, unchanged messages to be spread-copied.
      let messageModified = false;
      const newContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.content.length > maxChars) {
            messageModified = true;
            return { ...block, content: truncateToolResult(block.content, maxChars) };
          }
        }
        return block;
      });

      return messageModified ? { ...msg, content: newContent } : msg;
    });

    return result;
  }

  /**
   * Reactive compaction check — call during streaming to detect if
   * token usage is approaching the limit mid-turn.
   * Returns true if emergency compaction should be triggered.
   */
  shouldReactiveCompact(messages: Message[], currentResponseTokens: number): boolean {
    const msgTokens = this.estimateTokensHybrid(messages);
    const total = msgTokens + currentResponseTokens;
    // Trigger at the same gate as the emergency tier — keeps the streaming
    // reactive check aligned with the post-turn ladder.
    return total > this.config.maxTokens * this.config.summarizeAtRatio;
  }

  /**
   * Check if context is approaching limits.
   */
  checkLimits(messages: Message[]): {
    tokens: number;
    ratio: number;
    needsCompact: boolean;
    needsEmergency: boolean;
  } {
    const tokens = this.estimateTokensHybrid(messages);
    const ratio = tokens / this.config.maxTokens;
    return {
      tokens,
      ratio,
      needsCompact: ratio >= this.config.compactAtRatio,
      needsEmergency: ratio >= this.config.summarizeAtRatio,
    };
  }

}
