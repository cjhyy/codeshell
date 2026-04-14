/**
 * Model call facade — wraps LLM client with transcript integration.
 */

import type { LLMClientBase } from "../llm/client-base.js";
import type { Message, ToolDefinition, LLMResponse, StreamCallback } from "../types.js";
import { Transcript } from "../session/transcript.js";
import { logger } from "../logging/logger.js";
import { addAPIDuration, addToModelUsage, addInputTokens, addOutputTokens } from "../bootstrap/state.js";

export class ModelFacade {
  constructor(
    private readonly client: LLMClientBase,
    private readonly transcript: Transcript,
  ) {}

  async call(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    onStream?: StreamCallback,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    const msgCount = messages.length;

    const response = await this.client.createMessage({
      systemPrompt,
      messages,
      tools,
      stream: true,
      onChunk: (chunk) => {
        if (!onStream) return;
        if (chunk.type === "text" && chunk.text) {
          onStream({ type: "text_delta", text: chunk.text });
        } else if (chunk.type === "tool_use_start" && chunk.toolCall) {
          // Forward tool_use_start immediately so the UI can show progress
          // while JSON args are still streaming
          onStream({
            type: "tool_use_start",
            toolCall: {
              id: chunk.toolCall.id ?? "",
              toolName: chunk.toolCall.toolName ?? "",
              args: chunk.toolCall.args ?? {},
            },
          });
        }
      },
      signal,
    });

    const latencyMs = Date.now() - startMs;
    logger.info("llm.request", {
      stream: true,
      latencyMs,
      msgCount,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.length,
      textLen: response.text?.length ?? 0,
      usage: response.usage,
    });

    this.recordUsage(response, latencyMs);
    this.recordResponse(response);
    return response;
  }

  /**
   * Call without streaming — used as fallback when streaming fails.
   */
  async callWithoutStreaming(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    const msgCount = messages.length;

    const response = await this.client.createMessage({
      systemPrompt,
      messages,
      tools,
      stream: false,
      signal,
    });

    const latencyMs = Date.now() - startMs;
    logger.info("llm.request", {
      stream: false,
      latencyMs,
      msgCount,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.length,
      textLen: response.text?.length ?? 0,
      usage: response.usage,
    });

    this.recordUsage(response, latencyMs);
    this.recordResponse(response);
    return response;
  }

  /** Record API timing and token usage to bootstrap state. */
  private recordUsage(response: LLMResponse, latencyMs: number): void {
    addAPIDuration(latencyMs);
    const u = response.usage;
    if (u) {
      addInputTokens(u.inputTokens ?? 0);
      addOutputTokens(u.outputTokens ?? 0);
      addToModelUsage(
        this.client.modelName ?? "unknown",
        u.inputTokens ?? 0,
        u.outputTokens ?? 0,
        u.cacheReadTokens ?? 0,
        u.cacheWriteTokens ?? 0,
      );
    }
  }

  /** Optional summarize function for tool use summaries. */
  summarize?: (systemPrompt: string, userMessage: string) => Promise<string>;

  /** Get cumulative output tokens (for token budget). */
  getOutputTokens?(): number;

  private recordResponse(response: LLMResponse): void {
    if (response.text || response.toolCalls.length > 0) {
      const contentBlocks: import("../types.js").ContentBlock[] = [];

      if (response.text) {
        contentBlocks.push({ type: "text", text: response.text });
      }

      for (const tc of response.toolCalls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.toolName,
          input: tc.args,
        });
      }

      this.transcript.appendMessage("assistant", contentBlocks);
    }
  }

  getUsage() {
    return this.client.getUsage();
  }
}
