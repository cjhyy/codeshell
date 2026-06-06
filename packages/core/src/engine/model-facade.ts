/**
 * Model call facade — wraps LLM client with transcript integration.
 */

import type { LLMClientBase } from "../llm/client-base.js";
import type { Message, ToolDefinition, LLMResponse, StreamCallback } from "../types.js";
import { Transcript } from "../session/transcript.js";
import { logger, getCurrentSid } from "../logging/logger.js";
import { ContextLimitError } from "../exceptions.js";
import { isAbortError } from "../llm/client-base.js";
import {
  recordLLMError,
  recordLLMRequest,
  recordLLMResponse,
} from "../logging/session-recorder.js";
import { sanitizeMessages } from "../logging/sanitize-messages.js";
import { addAPIDuration, addToModelUsage, addInputTokens, addOutputTokens } from "../state.js";

let _reqSeq = 0;
function nextReqId(): string {
  _reqSeq += 1;
  return `r${_reqSeq.toString(36)}`;
}

export class ModelFacade {
  /**
   * Fallback clients tried in order when the primary fails with a terminal
   * (non-retryable, non-context, non-abort) error (TODO 7.2). Empty by default.
   */
  private readonly fallbacks: LLMClientBase[];

  constructor(
    private readonly client: LLMClientBase,
    private readonly transcript: Transcript,
    fallbacks: LLMClientBase[] = [],
  ) {
    this.fallbacks = fallbacks;
  }

  /**
   * Should we try a fallback model for this error? No for cancellation
   * (user intent), context-limit (a different model won't have more room for
   * THIS prompt — that's the context manager's job), and retryable transient
   * errors (the client's own withRetry already handled those before throwing).
   * Everything else (auth failures, 5xx after retries, model-unavailable) is a
   * candidate for switching models.
   */
  private shouldFallback(err: unknown): boolean {
    if (this.fallbacks.length === 0) return false;
    if (err instanceof ContextLimitError) return false;
    if (isAbortError(err)) return false;
    return true;
  }

  /**
   * Run `fn` against the primary client; on a terminal error, retry it against
   * each fallback client in order. Returns the first success; if every client
   * fails, throws the LAST error (most likely the most informative).
   */
  private async withModelFallback(
    fn: (client: LLMClientBase) => Promise<LLMResponse>,
  ): Promise<LLMResponse> {
    try {
      return await fn(this.client);
    } catch (primaryErr) {
      if (!this.shouldFallback(primaryErr)) throw primaryErr;
      let lastErr = primaryErr;
      for (const fb of this.fallbacks) {
        logger.warn("llm.model_fallback", {
          from: this.client.model ?? "?",
          to: fb.model ?? "?",
          error: (primaryErr as Error)?.message,
        });
        try {
          return await fn(fb);
        } catch (fbErr) {
          if (isAbortError(fbErr)) throw fbErr;
          lastErr = fbErr;
        }
      }
      throw lastErr;
    }
  }

  async call(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    onStream?: StreamCallback,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    const msgCount = messages.length;

    const sid = getCurrentSid();
    const reqId = nextReqId();
    recordLLMRequest(
      sid,
      {
        provider: this.client.provider ?? "?",
        model: this.client.model ?? "?",
        stream: true,
        // Image base64 payloads stay out of recorded prompts — see
        // logging/sanitize-messages.ts. Transcripts keep the full bytes
        // (needed for replay); logs do not.
        messages: sanitizeMessages(messages),
        tools,
        systemPrompt,
      },
      reqId,
    );

    let response: LLMResponse;
    try {
      response = await this.withModelFallback((client) =>
        client.createMessage({
          systemPrompt,
          messages,
          tools,
          stream: true,
          onChunk: (chunk) => {
            if (!onStream) return;
            if (chunk.type === "text" && chunk.text) {
              onStream({ type: "text_delta", text: chunk.text, tokens: chunk.tokens });
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
            } else if (chunk.type === "tool_use_delta" && chunk.toolCall?.id) {
              onStream({
                type: "tool_use_args_delta",
                toolCallId: chunk.toolCall.id,
                args: chunk.toolCall.args ?? {},
              });
            }
          },
          signal,
        }),
      );
    } catch (err) {
      recordLLMError(sid, reqId, err, Date.now() - startMs);
      throw err;
    }

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
    recordLLMResponse(
      sid,
      {
        text: response.text,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: response.usage,
        durationMs: latencyMs,
      },
      reqId,
    );

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

    const sid = getCurrentSid();
    const reqId = nextReqId();
    recordLLMRequest(
      sid,
      {
        provider: this.client.provider ?? "?",
        model: this.client.model ?? "?",
        stream: false,
        // Image base64 payloads stay out of recorded prompts — same rule
        // as the streaming path above.
        messages: sanitizeMessages(messages),
        tools,
        systemPrompt,
      },
      reqId,
    );

    let response: LLMResponse;
    try {
      response = await this.withModelFallback((client) =>
        client.createMessage({
          systemPrompt,
          messages,
          tools,
          stream: false,
          signal,
        }),
      );
    } catch (err) {
      recordLLMError(sid, reqId, err, Date.now() - startMs);
      throw err;
    }

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
    recordLLMResponse(
      sid,
      {
        text: response.text,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
        usage: response.usage,
        durationMs: latencyMs,
      },
      reqId,
    );

    this.recordUsage(response, latencyMs);
    this.recordResponse(response);
    return response;
  }

  /** Record API timing and token usage to bootstrap state. */
  private recordUsage(response: LLMResponse, latencyMs: number): void {
    addAPIDuration(latencyMs);
    const u = response.usage;
    if (u) {
      addInputTokens(u.promptTokens ?? 0);
      addOutputTokens(u.completionTokens ?? 0);
      addToModelUsage(
        this.client.model ?? "unknown",
        u.promptTokens ?? 0,
        u.completionTokens ?? 0,
        u.cacheReadTokens ?? 0,
        u.cacheCreationTokens ?? 0,
      );
    }
  }

  /** Optional summarize function for tool use summaries. */
  summarize?: (systemPrompt: string, userMessage: string) => Promise<string>;

  /** Get cumulative output tokens (for token budget). */
  getOutputTokens?(): number;

  private recordResponse(response: LLMResponse): void {
    if (response.text || response.toolCalls.length > 0 || response.reasoningContent) {
      const contentBlocks: import("../types.js").ContentBlock[] = [];

      // DeepSeek V4 thinking mode emits reasoning_content alongside the
      // reply; we echo it back on the next turn so the model can resume
      // its chain of thought. Persist as a dedicated block so transcript
      // -> message round-tripping preserves it without mixing into
      // displayable text. Goes first so it sits adjacent to the
      // assistant turn it belongs to even after compaction.
      if (response.reasoningContent) {
        contentBlocks.push({
          type: "reasoning",
          reasoningContent: response.reasoningContent,
        });
      }

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
