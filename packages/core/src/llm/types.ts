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
   * DeepSeek V4 thinking-mode switch. "enabled" is the endpoint default;
   * "disabled" turns reasoning off (faster, cheaper, no `reasoning_content`
   * on the reply). Ignored by every provider except DeepSeek V4 — the OpenAI
   * SDK forwards unknown top-level fields verbatim, so it's harmless on
   * other compatible endpoints.
   */
  thinking?: "enabled" | "disabled";
}

export interface LLMUsageTracker {
  records: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  requestCount: number;
}
