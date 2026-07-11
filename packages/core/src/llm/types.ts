/**
 * LLM-specific internal types.
 */

import type { Message, ToolDefinition, LLMResponse, LLMStreamChunk, TokenUsage } from "../types.js";

export interface CreateMessageOptions {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  onChunk?: (chunk: LLMStreamChunk) => void;
  signal?: AbortSignal;
  /**
   * Whether this real provider request is billed through the process-wide
   * usage hook. This is independent of request visibility: auxiliary calls
   * are normally billed while remaining hidden from the foreground request
   * tracker. Only explicit manual-audit paths should disable billing.
   * @default true
   */
  billingEnabled?: boolean;
  /**
   * Whether this request appears in the client's foreground usage tracker.
   * Hidden auxiliary calls must report their usage to their owning Engine's
   * session/Goal recorder instead.
   * @default true
   */
  requestVisible?: boolean;
  /**
   * Reasoning/thinking setting for this call. Overrides LLMConfig.reasoning.
   * Rich shape ({mode:"off"|"on"} | {mode:"effort",effort} |
   * {mode:"budget",budgetTokens}) — translated to the per-vendor wire form by
   * the client's capability layer.
   */
  reasoning?: import("./reasoning-setting.js").ReasoningSetting;
}

export interface LLMUsageTracker {
  records: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** Sum of cache-read tokens across responses (0 when no provider reported any). */
  totalCacheReadTokens: number;
  /** Sum of cache-creation tokens across responses. */
  totalCacheCreationTokens: number;
  requestCount: number;
}
