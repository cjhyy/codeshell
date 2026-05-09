/**
 * OpenAI GPT provider using openai SDK.
 */

import OpenAI from "openai";
import type { LLMConfig, LLMResponse, ToolCall, ToolDefinition, TokenUsage } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";
import { LLMClientBase } from "../client-base.js";
import { ContextLimitError, LLMError, LLMRateLimitError } from "../../exceptions.js";
import { logger } from "../../logging/logger.js";

export class OpenAIClient extends LLMClientBase {
  private _client: OpenAI | null = null;

  constructor(config: LLMConfig) {
    super(config);
  }

  protected initClient(): void {
    // Lazy init — client created on first use
  }

  private get client(): OpenAI {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.config.apiKey ?? process.env.OPENAI_API_KEY,
        ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        timeout: this.timeout,
      });
    }
    return this._client;
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      const messages = this.buildMessages(options.systemPrompt, options.messages);
      const tools = options.tools?.length ? this.convertTools(options.tools) : undefined;

      const span = logger.span("llm.request", {
        cat: "llm",
        provider: this.provider,
        model: this.model,
        stream: !!(options.stream && options.onChunk),
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
      });
      try {
        const response =
          options.stream && options.onChunk
            ? await this.streamMessage(options, messages, tools)
            : await this.nonStreamMessage(options, messages, tools);
        span.end({
          stopReason: response.stopReason,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          cacheReadTokens: response.usage?.cacheReadTokens,
          cacheCreationTokens: response.usage?.cacheCreationTokens,
        });
        return response;
      } catch (err) {
        span.fail(err);
        throw err;
      }
    });
  }

  private async nonStreamMessage(
    options: CreateMessageOptions,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          max_tokens: options.maxTokens ?? this.maxTokens,
          messages,
          ...(tools ? { tools } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: options.signal },
      );

      const choice = response.choices[0];
      if (!choice) throw new LLMError("No response from OpenAI", "openai");

      const usage: TokenUsage = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      };
      this.recordUsage(usage);

      return this.processChoice(choice, usage);
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }
  }

  private async streamMessage(
    options: CreateMessageOptions,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<LLMResponse> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          max_tokens: options.maxTokens ?? this.maxTokens,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: options.signal },
      );

      let text = "";
      let reasoningContent = "";
      const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
      let streamUsage:
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        | undefined;

      // TTFT — first chunk that actually carried text. Tool-call-only chunks
      // earlier in the stream don't count: the user-visible "text starts now"
      // moment is what we want to compare across providers.
      const streamStartedAt = Date.now();
      let firstByteLogged = false;

      for await (const chunk of stream) {
        // Capture usage from the final chunk
        if ((chunk as any).usage) {
          streamUsage = (chunk as any).usage;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // DeepSeek thinking-mode streams reasoning as a separate delta
        // field. Accumulate it so we can echo it back next turn.
        const reasoningDelta = (delta as Record<string, unknown>).reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          reasoningContent += reasoningDelta;
        }

        if (delta.content) {
          if (!firstByteLogged) {
            firstByteLogged = true;
            logger.debug("llm.first_byte", {
              cat: "llm",
              provider: this.provider,
              model: this.model,
              ttft_ms: Date.now() - streamStartedAt,
            });
          }
          text += delta.content;
          options.onChunk?.({ type: "text", text: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              options.onChunk?.({
                type: "tool_use_start",
                toolCall: { id: tc.id, toolName: tc.function?.name },
              });
            }
            const existing = toolCallsMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
              // Best-effort partial-JSON parse: succeeds once a complete
              // top-level object has streamed in (typical for short args)
              // and silently waits otherwise.
              if (existing.id) {
                try {
                  const parsed = JSON.parse(existing.args || "{}");
                  options.onChunk?.({
                    type: "tool_use_delta",
                    toolCall: { id: existing.id, toolName: existing.name, args: parsed },
                  });
                } catch {
                  // partial JSON — wait for more deltas
                }
              }
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          options.onChunk?.({ type: "stop", stopReason: chunk.choices[0].finish_reason });
        }
      }

      const toolCalls: ToolCall[] = [];
      for (const [, tc] of toolCallsMap) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.args || "{}");
        } catch {}
        toolCalls.push({ id: tc.id, toolName: tc.name, args });
      }

      const usage: TokenUsage = {
        promptTokens: streamUsage?.prompt_tokens ?? 0,
        completionTokens: streamUsage?.completion_tokens ?? 0,
        totalTokens: streamUsage?.total_tokens ?? 0,
      };
      this.recordUsage(usage);

      return {
        text,
        toolCalls,
        usage,
        stopReason: "stop",
        ...(reasoningContent ? { reasoningContent } : {}),
      };
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }
  }

  private processChoice(choice: OpenAI.ChatCompletion.Choice, usage: TokenUsage): LLMResponse {
    const text = choice.message.content ?? "";
    const toolCalls: ToolCall[] = [];

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        toolCalls.push({
          id: tc.id,
          toolName: tc.function.name,
          args,
        });
      }
    }

    const reasoningContent = extractReasoningContent(
      choice.message as unknown as Record<string, unknown>,
    );

    return {
      text,
      toolCalls,
      usage,
      stopReason: choice.finish_reason ?? undefined,
      ...(reasoningContent ? { reasoningContent } : {}),
    };
  }

  private buildMessages(
    systemPrompt: string,
    messages: import("../../types.js").Message[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    // DeepSeek thinking-mode contract: every assistant turn we send
    // back must carry reasoning_content. Pre-thinking-fix transcripts
    // (and any assistant turn we synthesized ourselves, e.g. injected
    // hints) won't have one, so we backfill an empty placeholder for
    // those turns. The endpoint accepts an empty string here; what it
    // refuses is the field being entirely absent.
    const needsReasoningBackfill = isDeepSeekThinkingModel(this.model);

    for (const msg of messages) {
      if (msg.role === "system") continue;

      if (msg.role === "assistant") {
        const param: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant" };
        let reasoningContent: string | undefined;

        if (typeof msg.content === "string") {
          param.content = msg.content;
        } else {
          const textParts: string[] = [];
          const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "tool_use" && block.id && block.name) {
              toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                },
              });
            } else if (block.type === "reasoning" && block.reasoningContent) {
              reasoningContent = block.reasoningContent;
            }
            // Reasoning may also ride alongside another block (e.g. on a
            // text block) — pick it up wherever it appears so we never
            // silently drop it.
            if (!reasoningContent && block.reasoningContent) {
              reasoningContent = block.reasoningContent;
            }
          }

          if (textParts.length) param.content = textParts.join("\n");
          if (toolCalls.length) param.tool_calls = toolCalls;
        }

        if (!reasoningContent && needsReasoningBackfill) {
          reasoningContent = "";
        }
        if (reasoningContent !== undefined) {
          // Non-standard field required by DeepSeek thinking mode.
          // Standard OpenAI endpoints ignore unknown fields, so this
          // is safe to send unconditionally on the OpenAI-compatible
          // transport.
          (param as unknown as Record<string, unknown>).reasoning_content = reasoningContent;
        }
        result.push(param);
      } else if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.tool_call_id ?? "",
          content: typeof msg.content === "string" ? msg.content : "",
        });
      } else {
        // user messages — may contain tool_result blocks mixed with text
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else {
          // Separate tool_result blocks from text blocks
          const textParts: string[] = [];
          const toolResults: { tool_use_id: string; content: string }[] = [];

          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              toolResults.push({
                tool_use_id: block.tool_use_id,
                content: typeof block.content === "string" ? block.content : "",
              });
            } else if (block.type === "text" && block.text) {
              textParts.push(block.text);
            }
          }

          // Emit tool_result blocks as separate tool messages
          for (const tr of toolResults) {
            result.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }

          // Emit remaining text as user message
          if (textParts.length > 0) {
            result.push({ role: "user", content: textParts.join("\n") });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private handleApiError(err: unknown): never {
    if (err instanceof OpenAI.APIError) {
      if (err.status === 429) {
        throw new LLMRateLimitError("openai");
      }
      const msg = (err.message ?? "").toLowerCase();
      if (
        msg.includes("context_length_exceeded") ||
        msg.includes("maximum context length") ||
        msg.includes("too many tokens") ||
        msg.includes("prompt is too long")
      ) {
        throw new ContextLimitError("openai");
      }
      // OpenRouter and other compatible endpoints often return 401 "Provider
      // returned error" when the routed backend disables function calling for
      // the selected model. A real auth failure is also possible — surface
      // both possibilities so users don't blindly swap models.
      if (err.status === 401 && msg.includes("provider returned error")) {
        throw new LLMError(
          `OpenAI-compatible endpoint returned 401 "Provider returned error". ` +
            `Two likely causes: (1) the API key is invalid/revoked, or ` +
            `(2) the upstream provider rejects tool calls for this model ` +
            `(common on OpenRouter's gpt-4o-mini route). Verify the key, ` +
            `then try a tool-capable model such as openai/gpt-4.1-mini or ` +
            `anthropic/claude-3.5-haiku.`,
          "openai",
          { status: err.status },
        );
      }
      throw new LLMError(`OpenAI API error: ${err.message}`, "openai", { status: err.status });
    }
    throw err;
  }
}

/**
 * Pull a non-empty reasoning payload out of a provider message.
 *
 * DeepSeek thinking mode emits this on the assistant message; the
 * spec requires that the same value be echoed back on the next
 * request. Some routers also surface it under `reasoning`.
 */
function extractReasoningContent(msg: Record<string, unknown>): string | undefined {
  const candidate = msg.reasoning_content ?? msg.reasoning;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * DeepSeek's V4 thinking models require every assistant message in
 * the request history to carry a `reasoning_content` field — even an
 * empty string is accepted; the field being entirely absent is what
 * the endpoint refuses with HTTP 400.
 *
 * Scoped narrowly to the V4 family (`deepseek-v4-pro`,
 * `deepseek-v4-flash`, etc.). Other DeepSeek namings — e.g. the
 * OpenRouter-style `deepseek/deepseek-v3.2`, or the standalone `r1`
 * line — don't enforce this contract and shouldn't get the backfill.
 */
function isDeepSeekThinkingModel(model: string): boolean {
  return /^deepseek-v4(?:-|$)/i.test(model);
}
