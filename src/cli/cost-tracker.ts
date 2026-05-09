/**
 * Cost tracker — tracks token usage and calculates estimated costs.
 */

import chalk from "chalk";
import { findOpenRouterModel } from "../data/openrouter-models.js";

// Pricing per 1M tokens (USD) — common models via OpenRouter/direct
// cacheRead = price for cached input tokens (typically 90% cheaper than input)
// cacheWrite = price for cache creation tokens (typically 25% more than input)
interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function pricing(input: number, output: number): ModelPricing {
  // Default cache pricing: read = 10% of input, write = 125% of input
  return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (per 1M tokens, USD)
  "claude-opus-4.6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, // alias
  "claude-opus-4.5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4.1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, // alias
  "claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3.7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3.5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, // alias
  // OpenAI
  "gpt-5.4": pricing(5, 20),
  "gpt-5.4-mini": pricing(1.5, 6),
  "gpt-5.4-pro": pricing(10, 40),
  "gpt-5": pricing(5, 20),
  "gpt-4o": pricing(2.5, 10),
  "gpt-4o-mini": pricing(0.15, 0.6),
  "gpt-4.1": pricing(2, 8),
  "gpt-4.1-mini": pricing(0.4, 1.6),
  "o4-mini": pricing(1.1, 4.4),
  "o3": pricing(10, 40),
  "o3-mini": pricing(1.1, 4.4),
  // Google
  "gemini-2.5-pro": pricing(1.25, 10),
  "gemini-2.5-pro-preview": pricing(1.25, 10),
  "gemini-2.5-flash": pricing(0.15, 0.6),
  "gemini-3.1-pro-preview": pricing(2, 10),
  "gemini-3-flash-preview": pricing(0.15, 0.6),
  "gemini-2.0-flash": pricing(0.1, 0.4),
  // DeepSeek
  "deepseek-v3.2": pricing(0.14, 0.28),
  "deepseek-chat": pricing(0.14, 0.28),
  "deepseek-r1": pricing(0.55, 2.19),
  "deepseek-reasoner": pricing(0.55, 2.19),
  // Qwen
  "qwen3-coder": pricing(0.3, 0.6),
  "qwen3-235b-a22b": pricing(0.3, 1.2),
  "qwen3-30b-a3b": pricing(0.1, 0.3),
  "qwen3-max": pricing(0.5, 2),
  // Meta
  "llama-4-maverick": pricing(0.2, 0.8),
  "llama-4-scout": pricing(0.15, 0.4),
  // Mistral
  "devstral-medium": pricing(0.5, 1.5),
  "mistral-large": pricing(2, 6),
  "devstral-small": pricing(0.1, 0.3),
};

// Default fallback pricing
const DEFAULT_PRICING: ModelPricing = pricing(3, 15);

/**
 * Resolve pricing for a model. Lookup order:
 *   1. OpenRouter snapshot (when the ID looks like vendor/model)
 *   2. MODEL_PRICING by canonical name (strips provider prefix)
 *   3. MODEL_PRICING by raw name
 *   4. DEFAULT_PRICING fallback
 *
 * Returns { pricing, source } so callers can flag unknown-model warnings
 * accurately (the snapshot path counts as known even if MODEL_PRICING misses).
 */
function lookupPricing(model: string): { pricing: ModelPricing; known: boolean } {
  if (model.includes("/")) {
    const hit = findOpenRouterModel(model);
    if (hit && (hit.inputPricePerMillion > 0 || hit.outputPricePerMillion > 0)) {
      const input = hit.inputPricePerMillion;
      const output = hit.outputPricePerMillion;
      return {
        pricing: {
          input,
          output,
          // Snapshot doesn't carry cache pricing; use the same heuristic as pricing() helper
          cacheRead: input * 0.1,
          cacheWrite: input * 1.25,
        },
        known: true,
      };
    }
  }
  const canonical = getCanonicalName(model);
  const hit = MODEL_PRICING[canonical] ?? MODEL_PRICING[model];
  if (hit) return { pricing: hit, known: true };
  return { pricing: DEFAULT_PRICING, known: false };
}

export interface UsageRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  timestamp: number;
  isSubAgent?: boolean;
}

/** Normalize model names: strip provider prefix and version suffixes for consistent grouping. */
function getCanonicalName(model: string): string {
  // "anthropic/claude-opus-4-6" → "claude-opus-4-6"
  const slashIdx = model.lastIndexOf("/");
  const base = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
  // Strip date suffixes like "-20250301"
  return base.replace(/-\d{8}$/, "");
}

export class CostTracker {
  private records: UsageRecord[] = [];
  private sessionStart = Date.now();
  private _hasUnknownModel = false;

  record(
    model: string,
    promptTokens: number,
    completionTokens: number,
    isSubAgent = false,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): void {
    const canonical = getCanonicalName(model);
    if (!lookupPricing(model).known && !lookupPricing(canonical).known) {
      this._hasUnknownModel = true;
    }
    this.records.push({
      model: canonical,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: promptTokens + completionTokens,
      timestamp: Date.now(),
      isSubAgent,
    });
  }

  getTotalTokens(): { prompt: number; completion: number; total: number } {
    let prompt = 0;
    let completion = 0;
    for (const r of this.records) {
      prompt += r.promptTokens;
      completion += r.completionTokens;
    }
    return { prompt, completion, total: prompt + completion };
  }

  getEstimatedCost(): number {
    let totalCost = 0;
    for (const r of this.records) {
      const { pricing: p } = lookupPricing(r.model);
      // promptTokens includes cache tokens — subtract them to avoid double billing
      const uncachedInput = Math.max(0, r.promptTokens - r.cacheReadTokens - r.cacheWriteTokens);
      totalCost += (uncachedInput / 1_000_000) * p.input;
      totalCost += (r.completionTokens / 1_000_000) * p.output;
      totalCost += (r.cacheReadTokens / 1_000_000) * p.cacheRead;
      totalCost += (r.cacheWriteTokens / 1_000_000) * p.cacheWrite;
    }
    return totalCost;
  }

  getRequestCount(): number {
    return this.records.length;
  }

  getSessionDuration(): number {
    return Date.now() - this.sessionStart;
  }

  /** Estimate cost for a specific set of tokens without recording them. */
  estimateForTokens(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  ): number {
    const { pricing: p } = lookupPricing(model);
    const uncachedInput = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
    return (
      (uncachedInput / 1_000_000) * p.input +
      (completionTokens / 1_000_000) * p.output +
      (cacheReadTokens / 1_000_000) * p.cacheRead +
      (cacheWriteTokens / 1_000_000) * p.cacheWrite
    );
  }

  /**
   * Get total cache token counts.
   */
  getCacheTokens(): { cacheRead: number; cacheWrite: number } {
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const r of this.records) {
      cacheRead += r.cacheReadTokens;
      cacheWrite += r.cacheWriteTokens;
    }
    return { cacheRead, cacheWrite };
  }

  /**
   * Format a styled cost summary for terminal display.
   */
  formatSummary(): string {
    const tokens = this.getTotalTokens();
    const cache = this.getCacheTokens();
    const cost = this.getEstimatedCost();
    const requests = this.getRequestCount();
    const duration = this.getSessionDuration();

    const lines: string[] = [];
    lines.push(`  ${chalk.bold.cyan("Cost Summary")}`);
    lines.push(chalk.dim("  ─".repeat(25)));
    lines.push(`    ${chalk.dim("Requests:")}      ${chalk.white(String(requests))}`);
    lines.push(`    ${chalk.dim("Input tokens:")}  ${chalk.white(formatNumber(tokens.prompt))}`);
    lines.push(`    ${chalk.dim("Output tokens:")} ${chalk.white(formatNumber(tokens.completion))}`);
    if (cache.cacheRead > 0 || cache.cacheWrite > 0) {
      lines.push(`    ${chalk.dim("Cache read:")}    ${chalk.white(formatNumber(cache.cacheRead))}`);
      lines.push(`    ${chalk.dim("Cache write:")}   ${chalk.white(formatNumber(cache.cacheWrite))}`);
    }
    lines.push(`    ${chalk.dim("Total cost:")}    ${chalk.green(formatCost(cost))}`);
    lines.push(`    ${chalk.dim("Duration:")}      ${chalk.white(formatDuration(duration))}`);

    // Per-model breakdown (always show)
    const modelMap = new Map<string, {
      prompt: number; completion: number; cacheRead: number; cacheWrite: number; count: number;
    }>();
    for (const r of this.records) {
      const existing = modelMap.get(r.model) ?? { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, count: 0 };
      existing.prompt += r.promptTokens;
      existing.completion += r.completionTokens;
      existing.cacheRead += r.cacheReadTokens;
      existing.cacheWrite += r.cacheWriteTokens;
      existing.count++;
      modelMap.set(r.model, existing);
    }

    if (modelMap.size >= 1) {
      lines.push("");
      lines.push(`    ${chalk.dim("By model:")}`);
      for (const [model, stats] of modelMap) {
        const { pricing: p } = lookupPricing(model);
        const uncachedInput = Math.max(0, stats.prompt - stats.cacheRead - stats.cacheWrite);
        const modelCost =
          (uncachedInput / 1_000_000) * p.input +
          (stats.completion / 1_000_000) * p.output +
          (stats.cacheRead / 1_000_000) * p.cacheRead +
          (stats.cacheWrite / 1_000_000) * p.cacheWrite;
        const tokenDetail = `${formatNumber(stats.prompt)} in, ${formatNumber(stats.completion)} out` +
          (stats.cacheRead > 0 ? `, ${formatNumber(stats.cacheRead)} cache` : "");
        lines.push(
          `      ${chalk.dim(model)} — ${tokenDetail}, ${formatCost(modelCost)} (${stats.count} reqs)`,
        );
      }
    }

    if (this._hasUnknownModel) {
      lines.push("");
      lines.push(chalk.dim("    (costs may be inaccurate due to usage of unknown models)"));
    }

    return lines.join("\n");
  }

  /**
   * Format a compact one-line cost display for the prompt footer.
   */
  formatCompact(): string {
    const tokens = this.getTotalTokens();
    const cost = this.getEstimatedCost();
    return chalk.dim(
      `tokens: ${formatNumber(tokens.total)} | cost: ${formatCost(cost)}`,
    );
  }

  reset(): void {
    this.records = [];
    this.sessionStart = Date.now();
  }

  /** Serialize cost state for session persistence. */
  serialize(): SessionCostState {
    const tokens = this.getTotalTokens();
    return {
      records: this.records,
      sessionStart: this.sessionStart,
      totalPromptTokens: tokens.prompt,
      totalCompletionTokens: tokens.completion,
      estimatedCost: this.getEstimatedCost(),
    };
  }

  /** Restore cost state from a previous session. */
  restore(state: SessionCostState): void {
    this.records = state.records ?? [];
    this.sessionStart = state.sessionStart ?? Date.now();
  }
}

export interface SessionCostState {
  records: UsageRecord[];
  sessionStart: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  estimatedCost: number;
}

function formatCost(cost: number): string {
  if (cost >= 0.5) return `$${Math.round(cost * 100) / 100}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  if (cost > 0) return `$${cost.toFixed(6)}`;
  return "$0.00";
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// Singleton for the current session
export const costTracker = new CostTracker();

/**
 * Wire the LLM base-class usage hook into the singleton cost tracker.
 * Called once from main.ts so every LLM call (REPL, run, arena, sub-agents)
 * records into a single tracker without each call site having to remember.
 */
export async function installCostTracking(): Promise<void> {
  const { LLMClientBase } = await import("../llm/client-base.js");
  LLMClientBase.onUsage = (model, usage) => {
    costTracker.record(
      model,
      usage.promptTokens,
      usage.completionTokens,
      false,
      usage.cacheReadTokens ?? 0,
      usage.cacheCreationTokens ?? 0,
    );
  };
}
