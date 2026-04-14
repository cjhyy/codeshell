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
}

export interface LLMUsageTracker {
  records: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  requestCount: number;
}
