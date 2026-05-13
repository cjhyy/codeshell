/**
 * Context manager — three-tier context management.
 *
 * Tier 1: microcompact (sync, zero-cost) — clear old tool_result content
 * Tier 2: LLM summary (async) — generate summary of older messages via model call
 * Tier 3: window compact (sync, emergency) — aggressive truncation fallback
 */

import type { Message, LLMResponse } from "../types.js";
import {
  estimateTokens,
  microcompact,
  snipCompact,
  windowCompact,
  truncateToolResult,
  buildSummarizationPrompt,
  applySummaryCompaction,
  applyToolResultBudget,
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
  microcompactFloorRatio: 0.3,
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

export class ContextManager {
  private config: ContextManagerConfig;
  private toolCallHashes = new Map<string, { count: number; lastResult: string }>();
  private summarizeFn: SummarizeFn | undefined;
  private consecutiveSummaryFailures = 0;
  private lastSummary: string | undefined;
  /** Last known actual token count from API usage data. */
  private lastActualTokens: number | undefined;
  /** Message count at the time lastActualTokens was recorded. */
  private lastActualAtMessageCount: number | undefined;
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
  recordActualUsage(inputTokens: number, messageCount: number): void {
    this.lastActualTokens = inputTokens;
    this.lastActualAtMessageCount = messageCount;
  }

  /**
   * Best-effort token estimate: uses actual API usage as base if available,
   * plus estimation for messages added since the last API call.
   */
  private estimateTokensHybrid(messages: Message[]): number {
    if (
      this.lastActualTokens !== undefined &&
      this.lastActualAtMessageCount !== undefined &&
      this.lastActualAtMessageCount < messages.length
    ) {
      const newMessages = messages.slice(this.lastActualAtMessageCount);
      const newTokens = estimateTokens(newMessages);
      return this.lastActualTokens + newTokens;
    }
    return estimateTokens(messages);
  }

  /**
   * Set the summarize function (injected by Engine).
   */
  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn;
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

    // Tier 1: microcompact — see manage() for the rationale on the floor.
    const preTier1Tokens = this.estimateTokensHybrid(result);
    if (preTier1Tokens > this.config.maxTokens * this.config.microcompactFloorRatio) {
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

    const tokens = this.estimateTokensHybrid(result);
    const ratio = tokens / this.config.maxTokens;

    // Tier 2: LLM summary if approaching limit
    if (
      ratio >= this.config.compactAtRatio &&
      this.summarizeFn &&
      this.consecutiveSummaryFailures < 3
    ) {
      try {
        const keepRecentN = Math.max(8, Math.floor(result.length * 0.3));
        const messagesToSummarize = result.slice(1, -keepRecentN); // skip first (userContext) and recent

        if (messagesToSummarize.length > 3) {
          const prompt = buildSummarizationPrompt(messagesToSummarize);
          const summary = await this.summarizeFn(prompt);

          if (summary && summary.length > 50) {
            result = applySummaryCompaction(result, summary, keepRecentN, this.transcriptPath);
            this.consecutiveSummaryFailures = 0;
            this.lastSummary = summary;
            const after = estimateTokens(result);
            logger.info("context.summary_compact", {
              before: tokens,
              after,
              summaryLen: summary.length,
            });
            this.onCompact?.({ strategy: "summary", before: tokens, after });
            return result;
          }
        }
      } catch (err) {
        this.consecutiveSummaryFailures++;
        logger.warn("context.summary_failed", {
          failures: this.consecutiveSummaryFailures,
          error: (err as Error).message,
        });
      }
    }

    // Reuse the `tokens` we already computed above. We only get here if the
    // LLM summary path didn't fire (no summarizeFn, too many failures, or it
    // threw) — fall back to the same severity ladder as manage().
    let live = tokens;
    const snipGate = this.config.maxTokens * this.config.compactAtRatio;
    const windowGate = this.config.maxTokens * (this.config.compactAtRatio + 0.05);
    const emergencyGate = this.config.maxTokens * this.config.summarizeAtRatio;

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
    let modified = false;

    const result = messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;

      const newContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.content.length > maxChars) {
            modified = true;
            return { ...block, content: truncateToolResult(block.content, maxChars) };
          }
        }
        return block;
      });

      return modified ? { ...msg, content: newContent } : msg;
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

  /**
   * Deduplicate tool calls by hashing arguments.
   */
  deduplicateToolCalls(calls: Array<{ toolName: string; args: Record<string, unknown> }>): {
    toExecute: typeof calls;
    cached: Array<{ toolName: string; args: Record<string, unknown>; result: string }>;
  } {
    const toExecute: typeof calls = [];
    const cached: Array<{ toolName: string; args: Record<string, unknown>; result: string }> = [];

    for (const call of calls) {
      const hash = this.hashCall(call.toolName, call.args);
      const existing = this.toolCallHashes.get(hash);

      if (existing && existing.count >= 2) {
        cached.push({ ...call, result: existing.lastResult });
        existing.count++;
      } else {
        toExecute.push(call);
      }
    }

    return { toExecute, cached };
  }

  /**
   * Record a tool call result for dedup tracking.
   */
  recordToolResult(toolName: string, args: Record<string, unknown>, result: string): void {
    const hash = this.hashCall(toolName, args);
    const existing = this.toolCallHashes.get(hash);
    if (existing) {
      existing.count++;
      existing.lastResult = result;
    } else {
      this.toolCallHashes.set(hash, { count: 1, lastResult: result });
    }
  }

  private hashCall(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }
}
