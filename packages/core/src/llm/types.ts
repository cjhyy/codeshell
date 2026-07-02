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
   * If false, this call's usage is excluded from the client's usage tracker
   * and from the process-wide onUsage hook. Used for auxiliary sub-calls
   * (tool-summary, future helper prompts) that should not appear in
   * session_end.cost or skew turn/requestCount semantics.
   * @default true
   */
  recordUsage?: boolean;
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
