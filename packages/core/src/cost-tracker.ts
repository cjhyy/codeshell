/**
 * Cost tracker — tracks token usage and calculates estimated costs.
 */

import { NOOP_COLORIZER, type Colorizer } from "./colorizer.js";
import { findOpenRouterModel } from "./data/openrouter-models.js";
import {
  MODEL_PRICING,
  DEFAULT_PRICING,
  type ModelPricing,
} from "./data/model-metadata.js";

// Pricing per 1M tokens (USD). The MODEL_PRICING table + DEFAULT_PRICING now
// live in data/model-metadata.json (loaded by data/model-metadata.ts) so a
// price change is a data edit, not a code change. cacheRead/cacheWrite are
// derived there: read = 10% of input, write = 125% of input.

/** Build a ModelPricing from an OpenRouter snapshot entry. */
function openRouterPricing(hit: { inputPricePerMillion: number; outputPricePerMillion: number }): {
  pricing: ModelPricing;
  known: boolean;
} {
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

/**
 * Resolve pricing for a model. Lookup order:
 *   1. OpenRouter snapshot (by full ID like "deepseek/deepseek-v4-flash")
 *   2. OpenRouter snapshot (by short name like "deepseek-v4-flash" → tries common vendors)
 *   3. MODEL_PRICING by canonical name (strips provider prefix)
 *   4. MODEL_PRICING by raw name
 *   5. DEFAULT_PRICING fallback
 *
 * Returns { pricing, source } so callers can flag unknown-model warnings
 * accurately (the snapshot path counts as known even if MODEL_PRICING misses).
 */
function lookupPricing(model: string): { pricing: ModelPricing; known: boolean } {
  // Try OpenRouter snapshot lookup for models with vendor/ prefix
  if (model.includes("/")) {
    const hit = findOpenRouterModel(model);
    if (hit && (hit.inputPricePerMillion > 0 || hit.outputPricePerMillion > 0)) {
      return openRouterPricing(hit);
    }
  }
  // Also try OpenRouter for short names (e.g. "deepseek-v4-flash" → "deepseek/deepseek-v4-flash")
  // by matching on the model part after the slash
  const orHit = findOpenRouterModel(`deepseek/${model}`) ??
    findOpenRouterModel(`openai/${model}`) ??
    findOpenRouterModel(`anthropic/${model}`);
  if (orHit && (orHit.inputPricePerMillion > 0 || orHit.outputPricePerMillion > 0)) {
    return openRouterPricing(orHit);
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
  formatSummary(c: Colorizer = NOOP_COLORIZER): string {
    const tokens = this.getTotalTokens();
    const cache = this.getCacheTokens();
    const cost = this.getEstimatedCost();
    const requests = this.getRequestCount();
    const duration = this.getSessionDuration();

    const lines: string[] = [];
    lines.push(`  ${c.boldCyan("Cost Summary")}`);
    lines.push(c.dim("  ─".repeat(25)));
    lines.push(`    ${c.dim("Requests:")}      ${c.white(String(requests))}`);
    lines.push(`    ${c.dim("Input tokens:")}  ${c.white(formatNumber(tokens.prompt))}`);
    lines.push(`    ${c.dim("Output tokens:")} ${c.white(formatNumber(tokens.completion))}`);
    if (cache.cacheRead > 0 || cache.cacheWrite > 0) {
      lines.push(`    ${c.dim("Cache read:")}    ${c.white(formatNumber(cache.cacheRead))}`);
      lines.push(`    ${c.dim("Cache write:")}   ${c.white(formatNumber(cache.cacheWrite))}`);
    }
    lines.push(`    ${c.dim("Total cost:")}    ${c.green(formatCost(cost))}`);
    lines.push(`    ${c.dim("Duration:")}      ${c.white(formatDuration(duration))}`);

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
      lines.push(`    ${c.dim("By model:")}`);
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
          `      ${c.dim(model)} — ${tokenDetail}, ${formatCost(modelCost)} (${stats.count} reqs)`,
        );
      }
    }

    if (this._hasUnknownModel) {
      lines.push("");
      lines.push(c.dim("    (costs may be inaccurate due to usage of unknown models)"));
    }

    return lines.join("\n");
  }

  /**
   * Format a compact one-line cost display for the prompt footer.
   */
  formatCompact(c: Colorizer = NOOP_COLORIZER): string {
    const tokens = this.getTotalTokens();
    const cost = this.getEstimatedCost();
    return c.dim(
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
  const { LLMClientBase } = await import("./llm/client-base.js");
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
