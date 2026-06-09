/**
 * Anthropic Claude provider using @anthropic-ai/sdk.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ClientDefaults, LLMConfig, LLMResponse, ToolCall, ToolDefinition, TokenUsage } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";
import type { ReasoningSetting } from "../reasoning-setting.js";
import { LLMClientBase } from "../client-base.js";
import { ContextLimitError, LLMError, LLMRateLimitError } from "../../exceptions.js";
import { logger } from "../../logging/logger.js";
import { countTokens } from "../token-counter.js";
import { capabilitiesFor, type Capability } from "../capabilities/index.js";
import type { ProviderKindName } from "../provider-kinds.js";
import { resolveApiKey, resolveHeaders } from "../provider-auth.js";
import { stripVisionFromHistory } from "../strip-vision.js";

/**
 * Anthropic's `max_tokens` is required, so unlike OpenAI we can't omit it when
 * the model's ceiling is unknown. Use a conservative floor in that rare case
 * (every catalog Anthropic model resolves a real value via resolveMaxOutput, so
 * this only fires for an unconfigured/unknown model).
 */
const ANTHROPIC_FALLBACK_MAX_TOKENS = 4096;

/**
 * Default thinking budget when a budget-capable model wants "thinking on" but
 * no explicit token budget was given. Clamped up to the model's minimum.
 */
const ANTHROPIC_DEFAULT_THINKING_BUDGET = 4096;

/** Shape of the SDK's `thinking` request field when extended thinking is on. */
type ThinkingParam = { type: "enabled"; budget_tokens: number };

export class AnthropicClient extends LLMClientBase {
  private _client: Anthropic | null = null;

  constructor(config: LLMConfig, defaults?: ClientDefaults) {
    super(config, defaults);
  }

  protected initClient(): void {
    // Lazy init
  }

  private get client(): Anthropic {
    if (!this._client) {
      const headers = resolveHeaders(this.config.httpHeaders);
      this._client = new Anthropic({
        // explicit apiKey > authCommand stdout > ANTHROPIC_API_KEY (TODO 7.2).
        apiKey: resolveApiKey(this.config, process.env.ANTHROPIC_API_KEY),
        ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
        timeout: this.timeout,
      });
    }
    return this._client;
  }

  /**
   * Resolve the capability descriptor for the current model. `providerKind`
   * defaults to "anthropic" (this client only serves the Anthropic API).
   * Memoized — the model doesn't change mid-client.
   */
  private _capability: Capability | null = null;
  private get capability(): Capability {
    if (!this._capability) {
      const kind = (this.config.providerKind ?? "anthropic") as ProviderKindName;
      this._capability = capabilitiesFor(kind, this.model);
    }
    return this._capability;
  }

  /**
   * Translate the resolved ReasoningSetting into Anthropic's `thinking` field,
   * honoring the model's reasoning shape (rules.ts):
   *
   *  - `anthropic-budget` (Claude 4.0–4.5): supports explicit
   *    `thinking:{type:"enabled", budget_tokens≥minBudgetTokens}`.
   *      · mode "budget" → use budgetTokens (clamped up to minBudgetTokens)
   *      · mode "on"     → default budget (clamped up to minBudgetTokens)
   *      · mode "effort" → this family is budget-typed, not effort-typed, so
   *                        treat any effort selection as "on" with the default.
   *      · mode "off" / unset → return undefined (omit the field).
   *  - `anthropic-adaptive` (Claude 4.6+): thinking is automatic and NOT
   *    controllable; sending `type:"enabled"` 400s. Always omit → undefined.
   *  - anything else (Claude 3.x catch-all → kind "none"): omit → undefined.
   *
   * `maxTokens` is the request's max_tokens. Anthropic requires
   * max_tokens > budget_tokens when thinking is enabled, so we cap the budget
   * just below it (leaving headroom for the visible answer). The minBudgetTokens
   * floor still wins — if even the floor doesn't fit under max_tokens the model
   * itself rejects it, which surfaces as a clear API error rather than us
   * silently sending a degenerate budget.
   */
  private buildThinking(
    reasoning: ReasoningSetting | undefined,
    maxTokens: number,
  ): ThinkingParam | undefined {
    const cap = this.capability;
    if (cap.reasoning.kind !== "anthropic-budget") {
      // anthropic-adaptive and none: never send a thinking field.
      return undefined;
    }
    if (!reasoning || reasoning.mode === "off") {
      return undefined;
    }

    const min = cap.reasoning.minBudgetTokens;
    // Anthropic constraint: max_tokens must STRICTLY exceed budget_tokens, and
    // budget_tokens must be ≥ the model's minimum. If max_tokens can't fit a
    // min-sized thinking block plus at least `min` tokens of answer, there is
    // no valid budget — omit thinking entirely rather than emit budget_tokens
    // ≥ max_tokens (which the API rejects with a 400). This is reachable for
    // small-maxTokens auxiliary calls (judge/planner) on budget models.
    const ceiling = maxTokens - min;
    if (ceiling < min) {
      return undefined;
    }
    let budget =
      reasoning.mode === "budget"
        ? reasoning.budgetTokens
        : ANTHROPIC_DEFAULT_THINKING_BUDGET; // "on" or "effort" → default budget
    // Clamp into [min, ceiling] — both bounds are now guaranteed ≥ min.
    budget = Math.min(Math.max(budget, min), ceiling);

    return { type: "enabled", budget_tokens: budget };
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withRetry(async (requestSignal) => {
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
            ? await this.streamMessage(options, messages, tools, requestSignal)
            : await this.nonStreamMessage(options, messages, tools, requestSignal);
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
    }, { signal: options.signal });
  }

  private async nonStreamMessage(
    options: CreateMessageOptions,
    messages: Anthropic.MessageParam[],
    tools?: Anthropic.Tool[],
    requestSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    try {
      // Per-call reasoning wins; otherwise fall back to the provider/model
      // default (settings → LLMConfig.reasoning). Mirrors openai.ts.
      const reasoning = options.reasoning ?? this.config.reasoning;
      const maxTokens = options.maxTokens ?? this.maxTokens ?? ANTHROPIC_FALLBACK_MAX_TOKENS;
      const thinking = this.buildThinking(reasoning, maxTokens);
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          system: [
            {
              type: "text" as const,
              text: options.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          messages,
          ...(tools?.length ? { tools } : {}),
          ...(thinking ? { thinking } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: requestSignal ?? options.signal },
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
    requestSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    try {
      const reasoning = options.reasoning ?? this.config.reasoning;
      const maxTokens = options.maxTokens ?? this.maxTokens ?? ANTHROPIC_FALLBACK_MAX_TOKENS;
      const thinking = this.buildThinking(reasoning, maxTokens);
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: maxTokens,
          system: [
            {
              type: "text" as const,
              text: options.systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ],
          messages,
          ...(tools?.length ? { tools } : {}),
          ...(thinking ? { thinking } : {}),
          ...(options.temperature !== undefined
            ? { temperature: options.temperature }
            : { temperature: this.temperature }),
        },
        { signal: requestSignal ?? options.signal },
      );

      let currentText = "";
      let currentToolName = "";
      let currentToolId = "";
      let currentToolInput = "";

      // Abort-guarded emit: once the turn is cancelled, stop forwarding chunks
      // to the UI. The SDK's event emitter can keep firing buffered text/
      // contentBlock/inputJson events after abort() until its HTTP stream tears
      // down; without this guard those leak to the UI after the user hit Stop
      // ("content comes back after interrupt"). We also eagerly abort the SDK
      // stream below so teardown starts immediately rather than waiting on the
      // passed-in request signal alone.
      const emit = (chunk: Parameters<NonNullable<typeof options.onChunk>>[0]) => {
        if (options.signal?.aborted) return;
        options.onChunk?.(chunk);
      };
      // Tear the SDK stream down on EITHER the user's cancel OR the per-request
      // deadline (requestSignal composes both) — a wedged stream then aborts
      // instead of hanging on the SDK's unreliable timeout.
      const teardownSig = requestSignal ?? options.signal;
      if (teardownSig) {
        if (teardownSig.aborted) stream.abort();
        else teardownSig.addEventListener("abort", () => stream.abort(), { once: true });
      }

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
        emit({ type: "text", text, tokens: countTokens(text) });
      });

      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") {
          currentToolName = block.name;
          currentToolId = block.id;
          currentToolInput = "";
          emit({
            type: "tool_use_start",
            toolCall: { id: block.id, toolName: block.name, args: {} },
          });
        }
      });

      stream.on("inputJson", (_delta, snapshot) => {
        currentToolInput = JSON.stringify(snapshot);
        if (currentToolId) {
          emit({
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
    messages = stripVisionFromHistory(messages, this.capability.supportsVision);
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
            let content: Anthropic.ToolResultBlockParam["content"];
            if (typeof block.content === "string") {
              content = block.content;
            } else if (Array.isArray(block.content)) {
              const parts: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
              for (const part of block.content) {
                if (part.type === "text" && part.text) {
                  parts.push({ type: "text", text: part.text });
                } else if (part.type === "image" && part.source) {
                  parts.push({
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: part.source.media_type as
                        | "image/jpeg"
                        | "image/png"
                        | "image/gif"
                        | "image/webp",
                      data: part.source.data,
                    },
                  });
                }
              }
              content = parts;
            } else {
              content = "";
            }
            blocks.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content,
              ...(block.is_error ? { is_error: true } : {}),
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
    // ESC / Stop path — see openai.ts handleApiError for the same logic.
    // Rethrow the SDK's abort error unchanged so server.ts recognises
    // cancellation; don't repackage it as a generic "Anthropic API error".
    if (err instanceof Anthropic.APIUserAbortError) {
      throw err;
    }
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
