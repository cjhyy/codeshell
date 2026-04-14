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
import { logger } from "../logging/logger.js";

export interface ContextManagerConfig {
  maxTokens: number;
  compactAtRatio: number;
  summarizeAtRatio: number;
  maxToolResultChars: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokens: 200_000,
  compactAtRatio: 0.6,
  summarizeAtRatio: 0.8,
  maxToolResultChars: 30_000,
};

/**
 * Async function type for LLM summarization calls.
 * Injected by the Engine so the ContextManager doesn't depend on LLM directly.
 */
export type SummarizeFn = (prompt: string) => Promise<string>;

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

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
   * Set the transcript path so compaction can reference it.
   */
  setTranscriptPath(path: string): void {
    this.transcriptPath = path;
  }

  /**
   * Apply progressive context management (sync path).
   * For Tier 2 (LLM summary), call manageAsync instead.
   */
  manage(messages: Message[]): Message[] {
    let result = messages;

    // Tier 0: Truncate oversized tool results
    result = this.truncateToolResults(result);

    // Tier 0b: Aggregate tool result budget (per-message)
    result = applyToolResultBudget(result);

    // Tier 1: Always apply microcompact
    result = microcompact(result);

    // Tier 2 sync fallback: window compact if approaching limit
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * this.config.compactAtRatio) {
      // If we have a cached summary, use it
      if (this.lastSummary) {
        const keepN = Math.max(8, Math.floor(result.length * 0.3));
        result = applySummaryCompaction(result, this.lastSummary, keepN, this.transcriptPath);
        this.lastSummary = undefined;
      } else {
        const keepN = Math.max(10, Math.floor(result.length * 0.4));
        result = windowCompact(result, keepN);
      }
    }

    // Tier 2b: Snip compact — keep first+last, drop middle (less aggressive than window)
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * 0.7) {
      result = snipCompact(result, 3, 8);
    }

    // Tier 3: Emergency — aggressive window if still too large
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * this.config.summarizeAtRatio) {
      result = windowCompact(result, 6);
    }

    return result;
  }

  /**
   * Async context management — attempts LLM summarization before falling back.
   * Call this when you have access to the LLM (between turns).
   */
  async manageAsync(messages: Message[]): Promise<Message[]> {
    let result = messages;

    // Tier 0: Truncate oversized tool results
    result = this.truncateToolResults(result);

    // Tier 0b: Aggregate tool result budget (per-message)
    result = applyToolResultBudget(result);

    // Tier 1: microcompact
    result = microcompact(result);

    const tokens = this.estimateTokensHybrid(result);
    const ratio = tokens / this.config.maxTokens;

    // Tier 2: LLM summary if approaching limit
    if (ratio >= this.config.compactAtRatio && this.summarizeFn && this.consecutiveSummaryFailures < 3) {
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
            logger.info("context.summary_compact", {
              before: tokens,
              after: estimateTokens(result),
              summaryLen: summary.length,
            });
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

    // Tier 2 fallback: window compact
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * this.config.compactAtRatio) {
      const keepN = Math.max(10, Math.floor(result.length * 0.4));
      result = windowCompact(result, keepN);
    }

    // Tier 2b: Snip compact
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * 0.7) {
      result = snipCompact(result, 3, 8);
    }

    // Tier 3: Emergency
    if (this.estimateTokensHybrid(result) > this.config.maxTokens * this.config.summarizeAtRatio) {
      result = windowCompact(result, 6);
    }

    return result;
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
    // Trigger at 90% of max — leaves 10% headroom for the response to finish
    return total > this.config.maxTokens * 0.9;
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
  deduplicateToolCalls(
    calls: Array<{ toolName: string; args: Record<string, unknown> }>,
  ): {
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
