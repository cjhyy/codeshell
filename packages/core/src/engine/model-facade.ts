/**
 * Model call facade — wraps LLM client with transcript integration.
 */

import type { LLMClientBase } from "../llm/client-base.js";
import type { Message, ToolDefinition, LLMResponse, StreamCallback } from "../types.js";
import { Transcript } from "../session/transcript.js";
import { logger, getCurrentSid } from "../logging/logger.js";
import {
  recordLLMError,
  recordLLMRequest,
  recordLLMResponse,
} from "../logging/session-recorder.js";
import { sanitizeMessages } from "../logging/sanitize-messages.js";
import { addAPIDuration, addToModelUsage, addInputTokens, addOutputTokens } from "../state.js";
import { cacheHitRateFromUsage } from "./session-usage.js";
import {
  createPromptPrefixFingerprint,
  type PromptPrefixFingerprint,
} from "./prompt-cache-diagnostics.js";

export interface ModelCallRecordingOptions {
  sensitiveToolResultRedactions?: ReadonlyMap<string, string>;
}

let _reqSeq = 0;
function nextReqId(): string {
  _reqSeq += 1;
  return `r${_reqSeq.toString(36)}`;
}

/**
 * Prompt-cache hit rate for one request, as CC computes it:
 *   cacheRead / (cacheRead + cacheCreation + uncachedInput)
 * where uncachedInput = promptTokens − cacheRead − cacheCreation (promptTokens
 * already includes the cached portion). Returns undefined when the provider
 * reported no cache info at all, so `llm.request` only carries the field when
 * it's meaningful. Makes hit-rate observable in logs — the prerequisite for
 * any caching tuning (docs/todo/prompt-cache-optimization.md §四 step 1).
 */
export function cacheHitRate(usage: LLMResponse["usage"]): number | undefined {
  return cacheHitRateFromUsage(usage);
}

export class ModelFacade {
  constructor(
    private readonly client: LLMClientBase,
    private readonly transcript: Transcript,
  ) {}

  getPromptPrefixFingerprint(
    systemPrompt: string,
    tools: readonly ToolDefinition[],
  ): PromptPrefixFingerprint {
    const client = this.client as LLMClientBase & {
      getPromptCacheConfigIdentity?: () => Readonly<Record<string, unknown>>;
      getPromptCacheScopeIdentity?: () => Readonly<Record<string, unknown>>;
    };
    const fallbackIdentity = {
      provider: client.provider ?? "unknown",
      model: client.model ?? "unknown",
      identityVersion: "legacy-client-v1",
    };
    return createPromptPrefixFingerprint(
      systemPrompt,
      tools,
      client.getPromptCacheConfigIdentity?.() ?? fallbackIdentity,
      client.getPromptCacheScopeIdentity?.() ?? fallbackIdentity,
    );
  }

  async call(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    onStream?: StreamCallback,
    signal?: AbortSignal,
    recordingOptions?: ModelCallRecordingOptions,
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
        messages: sanitizeMessages(messages, recordingOptions),
        tools,
        systemPrompt,
      },
      reqId,
    );

    let response: LLMResponse;
    try {
      response = await this.client.createMessage({
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
      });
    } catch (err) {
      recordLLMError(sid, reqId, err, Date.now() - startMs);
      throw err;
    }

    const latencyMs = Date.now() - startMs;
    const promptPrefix = this.getPromptPrefixFingerprint(systemPrompt, tools);
    logger.info("llm.request", {
      stream: true,
      latencyMs,
      msgCount,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.length,
      textLen: response.text?.length ?? 0,
      usage: response.usage,
      cacheHitRate: cacheHitRate(response.usage),
      promptPrefix,
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
    recordingOptions?: ModelCallRecordingOptions,
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
        messages: sanitizeMessages(messages, recordingOptions),
        tools,
        systemPrompt,
      },
      reqId,
    );

    let response: LLMResponse;
    try {
      response = await this.client.createMessage({
        systemPrompt,
        messages,
        tools,
        stream: false,
        signal,
      });
    } catch (err) {
      recordLLMError(sid, reqId, err, Date.now() - startMs);
      throw err;
    }

    const latencyMs = Date.now() - startMs;
    const promptPrefix = this.getPromptPrefixFingerprint(systemPrompt, tools);
    logger.info("llm.request", {
      stream: false,
      latencyMs,
      msgCount,
      stopReason: response.stopReason,
      toolCalls: response.toolCalls.length,
      textLen: response.text?.length ?? 0,
      usage: response.usage,
      cacheHitRate: cacheHitRate(response.usage),
      promptPrefix,
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
