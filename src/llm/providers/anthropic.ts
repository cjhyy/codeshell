/**
 * Anthropic Claude provider using @anthropic-ai/sdk.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig, LLMResponse, ToolCall, ToolDefinition, TokenUsage } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";
import { LLMClientBase } from "../client-base.js";
import { ContextLimitError, LLMError, LLMRateLimitError } from "../../exceptions.js";
import { logger } from "../../logging/logger.js";
import { countTokens } from "../token-counter.js";

export class AnthropicClient extends LLMClientBase {
  private _client: Anthropic | null = null;

  constructor(config: LLMConfig) {
    super(config);
  }

  protected initClient(): void {
    // Lazy init
  }

  private get client(): Anthropic {
    if (!this._client) {
      this._client = new Anthropic({
        apiKey: this.config.apiKey ?? process.env.ANTHROPIC_API_KEY,
        ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        timeout: this.timeout,
      });
    }
    return this._client;
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      const messages = this.buildMessages(options.messages);
      const tools = options.tools ? this.convertTools(options.tools) : undefined;

      // One span per outbound LLM request. Begin emits debug-level so the
      // info log isn't spammed during normal operation; end emits info with
      // duration_ms + usage so `--debug=llm` already gives a quick latency
      // histogram even at info level.
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
    messages: Anthropic.MessageParam[],
    tools?: Anthropic.Tool[],
  ): Promise<LLMResponse> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: options.maxTokens ?? this.maxTokens,
          system: [
            {
              type: "text" as const,
              text: options.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          messages,
          ...(tools?.length ? { tools } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: options.signal },
      );

      const usage: TokenUsage = {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        cacheReadTokens: (response.usage as any).cache_read_input_tokens,
        cacheCreationTokens: (response.usage as any).cache_creation_input_tokens,
      };
      this.recordUsage(usage, options);

      return this.processResponse(response, usage);
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }
  }

  private async streamMessage(
    options: CreateMessageOptions,
    messages: Anthropic.MessageParam[],
    tools?: Anthropic.Tool[],
  ): Promise<LLMResponse> {
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: options.maxTokens ?? this.maxTokens,
          system: [
            {
              type: "text" as const,
              text: options.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          messages,
          ...(tools?.length ? { tools } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: options.signal },
      );

      let currentText = "";
      let currentToolName = "";
      let currentToolId = "";
      let currentToolInput = "";

      // Time-to-first-byte: log exactly once per stream so streaming-latency
      // questions ("model felt slow tonight") get a clean number per request.
      const streamStartedAt = Date.now();
      let firstByteLogged = false;

      stream.on("text", (text) => {
        if (!firstByteLogged) {
          firstByteLogged = true;
          logger.debug("llm.first_byte", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            ttft_ms: Date.now() - streamStartedAt,
          });
        }
        currentText += text;
        options.onChunk?.({ type: "text", text, tokens: countTokens(text) });
      });

      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") {
          currentToolName = block.name;
          currentToolId = block.id;
          currentToolInput = "";
          options.onChunk?.({
            type: "tool_use_start",
            toolCall: { id: block.id, toolName: block.name, args: {} },
          });
        }
      });

      stream.on("inputJson", (_delta, snapshot) => {
        currentToolInput = JSON.stringify(snapshot);
        if (currentToolId) {
          options.onChunk?.({
            type: "tool_use_delta",
            toolCall: {
              id: currentToolId,
              toolName: currentToolName,
              args: (snapshot ?? {}) as Record<string, unknown>,
            },
          });
        }
      });

      const finalMessage = await stream.finalMessage();

      const usage: TokenUsage = {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
        cacheReadTokens: (finalMessage.usage as any).cache_read_input_tokens,
        cacheCreationTokens: (finalMessage.usage as any).cache_creation_input_tokens,
      };
      this.recordUsage(usage, options);

      options.onChunk?.({ type: "stop", stopReason: finalMessage.stop_reason ?? undefined });

      return this.processResponse(finalMessage, usage);
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }
  }

  private processResponse(response: Anthropic.Message, usage: TokenUsage): LLMResponse {
    let text = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return {
      text,
      toolCalls,
      usage,
      stopReason: response.stop_reason ?? undefined,
    };
  }

  private buildMessages(messages: import("../../types.js").Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue;

      const role = msg.role === "tool" ? "user" : msg.role;

      if (typeof msg.content === "string") {
        result.push({ role: role as "user" | "assistant", content: msg.content });
      } else {
        const blocks: Anthropic.ContentBlockParam[] = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use" && block.id && block.name && block.input) {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          } else if (block.type === "tool_result" && block.tool_use_id) {
            blocks.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: typeof block.content === "string" ? block.content : "",
            });
          } else if (block.type === "image" && block.source) {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: block.source.media_type as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: block.source.data,
              },
            });
          }
        }
        if (blocks.length > 0) {
          result.push({ role: role as "user" | "assistant", content: blocks });
        }
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  private handleApiError(err: unknown): never {
    if (err instanceof Anthropic.APIError) {
      if (err.status === 429) {
        throw new LLMRateLimitError("anthropic");
      }
      if (
        err.message?.includes("prompt is too long") ||
        err.message?.includes("context_length_exceeded")
      ) {
        throw new ContextLimitError("anthropic");
      }
      throw new LLMError(`Anthropic API error: ${err.message}`, "anthropic", {
        status: err.status,
      });
    }
    throw err;
  }
}
