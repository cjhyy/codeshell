/**
 * Anthropic Claude provider using @anthropic-ai/sdk.
 */

import Anthropic from "@anthropic-ai/sdk";
import { withProviderRequestProjection } from "../../model-request-boundary/context.js";
import {
  recordModelTraceAttemptError,
  recordModelTraceAttemptResult,
} from "../../model-traces/context.js";
import type { ClientDefaults, LLMConfig, LLMResponse, ToolCall, TokenUsage } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";
import type { ReasoningSetting } from "../reasoning-setting.js";
import { LLMClientBase } from "../client-base.js";
import { ContextLimitError, LLMError, LLMRateLimitError } from "../../exceptions.js";
import { logger } from "../../logging/logger.js";
import { countTokens } from "../token-counter.js";
import { capabilitiesForConfig, type Capability } from "../capabilities/index.js";
import { resolveApiKey, resolveHeaders } from "../provider-auth.js";
import { stripVisionFromHistory } from "../strip-vision.js";
import {
  anthropicMessagesEndpoint,
  nativeToolDiscoveryEnabled,
  supportsNativeToolDiscoveryModel,
} from "../native-tool-discovery.js";
import { anthropicMessages, anthropicSystem, anthropicTools } from "./anthropic-discovery-wire.js";
import {
  resolvePromptCachePolicy,
  type PromptCachePolicy,
  type PromptCacheRequestContext,
} from "../prompt-cache.js";

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

/**
 * Anthropic reports uncached input, cache writes, and cache reads as three
 * disjoint counters. `TokenUsage.promptTokens` is the whole prompt throughout
 * CodeShell (OpenAI includes cached tokens in prompt_tokens), so normalize the
 * Anthropic shape before context accounting, compaction, cache-hit math, and
 * cost tracking consume it.
 */
function tokenUsageFromAnthropic(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheReadTokens + cacheCreationTokens;
  return {
    promptTokens,
    completionTokens: usage.output_tokens,
    totalTokens: promptTokens + usage.output_tokens,
    ...(usage.cache_read_input_tokens != null ? { cacheReadTokens } : {}),
    ...(usage.cache_creation_input_tokens != null ? { cacheCreationTokens } : {}),
  };
}

/** Bounded native support includes Sonnet 5's explicit thinking opt-out. */
type ThinkingParam = { type: "enabled"; budget_tokens: number } | { type: "disabled" };

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
      const endpoint = anthropicMessagesEndpoint(this.config);
      const openRouter = endpoint?.kind === "openrouter";
      const key = resolveApiKey(
        this.config,
        openRouter ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY,
      );
      this._client = new Anthropic({
        ...(openRouter ? { apiKey: null, authToken: key ?? null } : { apiKey: key }),
        ...((endpoint?.baseURL ?? this.config.baseUrl)
          ? { baseURL: endpoint?.baseURL ?? this.config.baseUrl }
          : {}),
        ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
        ...(this.fetch ? { fetch: this.fetch } : {}),
        timeout: this.timeout,
      });
    }
    return this._client;
  }

  /**
   * Resolve the same configured model capabilities used by tools/attachments.
   * Memoized — the model configuration doesn't change mid-client.
   */
  private _capability: Capability | null = null;
  private get capability(): Capability {
    if (!this._capability) {
      this._capability = capabilitiesForConfig(this.config);
    }
    return this._capability;
  }

  private promptCachePolicy(
    request?: PromptCacheRequestContext,
    reasoning = this.config.reasoning,
  ): PromptCachePolicy {
    return resolvePromptCachePolicy({
      provider: this.provider,
      providerKind: this.config.providerKind,
      model: this.model,
      baseUrl: this.config.baseUrl,
      reasoning,
      extraBody: this.config.extraBody,
      promptCaching: this.capability.promptCaching,
      request,
    });
  }

  override getPromptCacheConfigIdentity(): Readonly<Record<string, unknown>> {
    const cachePolicy = this.promptCachePolicy();
    return {
      ...super.getPromptCacheConfigIdentity(),
      cacheStrategy: cachePolicy.strategy,
      cacheLayoutVersion: cachePolicy.layoutVersion,
      cacheBreakpoints: cachePolicy.breakpoints,
      breakpointCount: cachePolicy.breakpoints.length,
      reasoningShape: this.capability.reasoning,
    };
  }

  /**
   * Translate the resolved ReasoningSetting into Anthropic's `thinking` field,
   * honoring the model's reasoning shape (rules.ts):
   *
   *  - Reviewed Sonnet 5 Messages routes: explicit off sends `disabled`.
   *    Omitting this field would enable thinking by default on that model.
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
    if (reasoning?.mode === "off" && supportsNativeToolDiscoveryModel(this.config))
      return { type: "disabled" };
    const cap = this.capability;
    if (cap.reasoning.kind !== "anthropic-budget") {
      // Other adaptive/unknown modes retain their existing request behavior.
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
      reasoning.mode === "budget" ? reasoning.budgetTokens : ANTHROPIC_DEFAULT_THINKING_BUDGET; // "on" or "effort" → default budget
    // Clamp into [min, ceiling] — both bounds are now guaranteed ≥ min.
    budget = Math.min(Math.max(budget, min), ceiling);

    return { type: "enabled", budget_tokens: budget };
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const reasoning = options.reasoning ?? this.config.reasoning;
    const cachePolicy = this.promptCachePolicy(options.promptCache, reasoning);
    if (
      options.tools?.some((tool) => tool.deferLoading) &&
      cachePolicy.toolDiscovery !== "tool-reference"
    )
      throw new LLMError(
        "Native deferred tools require a supported Anthropic Messages route with thinking explicitly disabled; start a new tool-cache cycle before changing reasoning.",
        "anthropic",
      );
    if (
      supportsNativeToolDiscoveryModel(this.config) &&
      reasoning?.mode === "off" &&
      !nativeToolDiscoveryEnabled({ ...this.config, reasoning })
    )
      throw new LLMError(
        "Explicitly disabled reasoning conflicts with extraBody.thinking; remove the conflicting override.",
        "anthropic",
      );
    return this.withRetry(
      async (requestSignal) => {
        const messages = anthropicMessages(
          stripVisionFromHistory(options.messages, this.capability.supportsVision),
          options.promptCache,
          cachePolicy,
          options.tools,
        );
        const tools = options.tools ? anthropicTools(options.tools, cachePolicy) : undefined;

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
          cacheStrategy: cachePolicy.strategy,
        });
        try {
          const response =
            options.stream && options.onChunk
              ? await this.streamMessage(options, messages, tools, requestSignal)
              : await this.nonStreamMessage(options, messages, tools, requestSignal);
          recordModelTraceAttemptResult(response);
          span.end({
            stopReason: response.stopReason,
            promptTokens: response.usage?.promptTokens,
            completionTokens: response.usage?.completionTokens,
            cacheReadTokens: response.usage?.cacheReadTokens,
            cacheCreationTokens: response.usage?.cacheCreationTokens,
          });
          return response;
        } catch (err) {
          recordModelTraceAttemptError(err);
          span.fail(err);
          throw err;
        }
      },
      { signal: options.signal },
    );
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
      const requestBody = {
        model: this.model,
        max_tokens: maxTokens,
        system: anthropicSystem(
          options.systemPrompt,
          this.promptCachePolicy(options.promptCache, reasoning),
        ),
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(!this.capability.rejectedParams.has("temperature")
          ? { temperature: options.temperature ?? this.temperature }
          : {}),
      };
      const response = await withProviderRequestProjection(
        "anthropic-messages",
        requestBody,
        () => this.client.messages.create(requestBody, { signal: requestSignal ?? options.signal }),
        { logicalCallId: options.requestBoundaryId },
      );

      const usage = tokenUsageFromAnthropic(response.usage);
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
      const requestBody = {
        model: this.model,
        max_tokens: maxTokens,
        system: anthropicSystem(
          options.systemPrompt,
          this.promptCachePolicy(options.promptCache, reasoning),
        ),
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(!this.capability.rejectedParams.has("temperature")
          ? { temperature: options.temperature ?? this.temperature }
          : {}),
        stream: true as const,
      };
      const stream = withProviderRequestProjection(
        "anthropic-messages",
        requestBody,
        () => this.client.messages.stream(requestBody, { signal: requestSignal ?? options.signal }),
        { logicalCallId: options.requestBoundaryId },
      );

      let currentToolName = "";
      let currentToolId = "";
      stream.on("streamEvent", (_event, snapshot) => {
        this.recordAttemptUsage(tokenUsageFromAnthropic(snapshot.usage), options);
      });

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
        emit({ type: "text", text, tokens: countTokens(text) });
      });

      // Track the open block from content_block_start: the SDK emits
      // `inputJson` while the block streams and `contentBlock` only at its
      // stop, so keying deltas off `contentBlock` lags one tool behind.
      stream.on("streamEvent", (event) => {
        if (event.type !== "content_block_start") return;
        const block = event.content_block;
        currentToolId = block.type === "tool_use" ? block.id : "";
        currentToolName = block.type === "tool_use" ? block.name : "";
        if (block.type === "tool_use") {
          emit({
            type: "tool_use_start",
            toolCall: { id: block.id, toolName: block.name, args: {} },
          });
        }
      });

      stream.on("inputJson", (_delta, snapshot) => {
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

      const usage = tokenUsageFromAnthropic(finalMessage.usage);
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
