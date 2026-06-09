/**
 * OpenAI GPT provider using openai SDK.
 *
 * Serves every OpenAI-compatible endpoint we support (OpenAI, DeepSeek,
 * OpenRouter, Z.AI, xAI, Mistral, Groq, Gemini-OpenAI-compat, Ollama,
 * custom). Per-(provider, model) request-shape divergence — token-limit
 * field name, rejected sampling params, thinking knob, reasoning echo —
 * is resolved through `capabilitiesFor()`, not hardcoded.
 */

import OpenAI from "openai";
import type { ClientDefaults, LLMConfig, LLMResponse, ToolCall, ToolDefinition, TokenUsage } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";
import type { ReasoningSetting } from "../reasoning-setting.js";
import { LLMClientBase } from "../client-base.js";
import { ContextLimitError, LLMError, LLMRateLimitError } from "../../exceptions.js";
import { logger } from "../../logging/logger.js";
import { countTokens } from "../token-counter.js";
import { capabilitiesFor, type Capability } from "../capabilities/index.js";
import { clampMaxTokens } from "../clamp-max-tokens.js";
import { resolveApiKey, resolveHeaders } from "../provider-auth.js";
import { stripVisionFromHistory } from "../strip-vision.js";
import type { ProviderKindName } from "../provider-kinds.js";
import {
  STREAM_WATCHDOG_CONFIG,
  StreamIdleTimeoutError,
} from "../stream-watchdog.js";

interface RunStreamOpts {
  idleTimeoutMs?: number;
  requestId?: string;
  /**
   * Per-chunk handler — invoked synchronously with the raw chunk for the
   * provider to do its own parsing. Returns the text delta (or "") for
   * the watchdog-side text accumulator used in tests.
   */
  onChunk?: (chunk: any) => string;
  /**
   * Abort signal. Checked BEFORE handing each chunk to onChunk so a cancelled
   * turn stops emitting text_delta immediately — the SDK keeps yielding
   * already-buffered chunks after abort() until its HTTP teardown completes, and
   * without this guard those buffered deltas leak to the UI after the user hit
   * Stop ("content comes back after interrupt").
   */
  signal?: AbortSignal;
  /**
   * Per-call override of the watchdog. Leave undefined to follow the env
   * default (STREAM_WATCHDOG_CONFIG.enabled). Set false to force the fast
   * path even when the watchdog is enabled globally; passing idleTimeoutMs
   * still re-activates it (an explicit timeout means the caller wants it).
   */
  disableWatchdog?: boolean;
}

/**
 * Consume an async iterable of stream chunks with an idle watchdog.
 * Returns the accumulated text — either from onChunk return values, or
 * by extracting choices[0].delta.content from raw chunks (useful in tests
 * that call runStreamWithWatchdog directly without an onChunk handler).
 *
 * The watchdog is active whenever opts.idleTimeoutMs is explicitly provided,
 * or when STREAM_WATCHDOG_CONFIG.enabled is true. When active, each call to
 * iterator.next() races against an idle deadline; if the deadline fires first
 * the function rejects with StreamIdleTimeoutError.
 */
export async function runStreamWithWatchdog<T = any>(
  stream: AsyncIterable<T>,
  opts: RunStreamOpts = {},
): Promise<string> {
  // An explicit idleTimeoutMs always activates the watchdog. Otherwise follow
  // disableWatchdog (per-call override) if set, else the env default.
  const watchdogActive =
    opts.idleTimeoutMs !== undefined ||
    (opts.disableWatchdog === undefined
      ? STREAM_WATCHDOG_CONFIG.enabled
      : !opts.disableWatchdog);
  const idleTimeoutMs =
    opts.idleTimeoutMs ?? STREAM_WATCHDOG_CONFIG.idleTimeoutMs;
  let text = "";

  // Fast path: watchdog disabled AND caller did not override → no overhead.
  if (!watchdogActive) {
    for await (const chunk of stream) {
      // Stop consuming the moment the turn is aborted — do NOT forward more
      // chunks to onChunk (which emits text_delta to the UI). The SDK may still
      // be draining buffered chunks after abort(); this prevents them leaking
      // post-Stop. `break` from a for-await calls the iterator's return() for us,
      // letting the SDK tear the stream down.
      if (opts.signal?.aborted) break;
      if (opts.onChunk) {
        text += opts.onChunk(chunk) ?? "";
      } else {
        text += (chunk as any)?.choices?.[0]?.delta?.content ?? "";
      }
    }
    return text;
  }

  // Watchdog path: race each iterator.next() against a per-chunk idle timer.
  // This ensures the for-await cannot block forever between chunks.
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      // Abort short-circuit: stop before awaiting/forwarding the next chunk so
      // buffered post-abort deltas never reach onChunk. The finally below calls
      // iterator.return() to tear the SDK stream down.
      if (opts.signal?.aborted) break;
      const nextPromise = iterator.next();

      // Build a timeout promise that rejects if no chunk arrives in time.
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new StreamIdleTimeoutError(idleTimeoutMs, opts.requestId));
        }, idleTimeoutMs);
      });

      // Abort promise: resolve as soon as the signal fires so a cancel mid-chunk
      // (while awaiting the next delta) breaks out immediately instead of
      // waiting for the next chunk or the idle deadline.
      const abortCleanups: Array<() => void> = [];
      const abortPromise = new Promise<{ aborted: true }>((resolve) => {
        const sig = opts.signal;
        if (!sig) return; // never resolves → no effect on the race
        if (sig.aborted) {
          resolve({ aborted: true });
          return;
        }
        const onAbort = () => resolve({ aborted: true });
        sig.addEventListener("abort", onAbort, { once: true });
        abortCleanups.push(() => sig.removeEventListener("abort", onAbort));
      });

      let result: IteratorResult<T> | { aborted: true };
      try {
        result = await Promise.race([nextPromise, timeoutPromise, abortPromise]);
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        for (const c of abortCleanups) c();
      }

      if ("aborted" in result) break;
      if (result.done) break;

      const chunk = result.value;
      if (opts.onChunk) {
        text += opts.onChunk(chunk) ?? "";
      } else {
        text += (chunk as any)?.choices?.[0]?.delta?.content ?? "";
      }
    }
  } finally {
    // Best-effort cleanup: signal iterator to stop. Do NOT await — if the
    // generator is stuck (e.g., wedged HTTP stream), awaiting return() would
    // itself hang. Fire-and-forget is intentional here.
    iterator.return?.();
  }
  return text;
}

export class OpenAIClient extends LLMClientBase {
  private _client: OpenAI | null = null;
  // Sticky override: once the endpoint tells us `max_tokens` is rejected for
  // this model, switch to `max_completion_tokens` for the lifetime of the
  // client. Cheaper and more reliable than re-deriving from the model id when
  // a new variant ships before our regex knows about it.
  private _forceMaxCompletionTokens = false;
  // Sticky override: some gpt-5.x variants reject `reasoning_effort` when it's
  // combined with `tools` on /v1/chat/completions ("Please use /v1/responses
  // instead"). Once we see that 400, drop `reasoning_effort` for the lifetime
  // of the client so tool-calling turns (e.g. the dream consolidation loop)
  // succeed. Omitting the field just means "model default reasoning", which is
  // fine for our background/aux calls.
  private _dropReasoningEffort = false;

  constructor(config: LLMConfig, defaults?: ClientDefaults) {
    super(config, defaults);
  }

  protected initClient(): void {
    // Lazy init — client created on first use
  }

  private get client(): OpenAI {
    if (!this._client) {
      const headers = resolveHeaders(this.config.httpHeaders);
      this._client = new OpenAI({
        // apiKey: explicit > authCommand stdout > OPENAI_API_KEY (TODO 7.2).
        // OpenAI's SDK requires a non-empty string; fall back to a placeholder
        // when a custom provider authenticates purely via httpHeaders.
        apiKey:
          resolveApiKey(this.config, process.env.OPENAI_API_KEY) ??
          (Object.keys(headers).length > 0 ? "x-headers-auth" : undefined),
        ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
        ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
        timeout: this.timeout,
      });
    }
    return this._client;
  }

  /**
   * Resolve the capability descriptor for the current (provider kind, model)
   * pair. Cached for the lifetime of the client — model never changes
   * mid-client. `providerKind` defaults to "openai" because legacy LLMConfig
   * paths (arena, env-derived) don't always populate it; for those, the
   * built-in rules table treats them as plain OpenAI.
   */
  private _capability: Capability | null = null;
  private get capability(): Capability {
    if (!this._capability) {
      const kind = (this.config.providerKind ?? "openai") as ProviderKindName;
      this._capability = capabilitiesFor(kind, this.model);
    }
    return this._capability;
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    return this.withRetry(async (requestSignal) => {
      // requestSignal = caller's cancel signal composed with a per-request
      // hard deadline (withRetry). Hand it to the SDK so a wedged socket is
      // torn down instead of hanging for tens of minutes.
      // Per-call reasoning wins; otherwise fall back to provider default
      // (settings.providers[].reasoning, threaded through LLMConfig).
      const reasoning = options.reasoning ?? this.config.reasoning;
      const messages = this.buildMessages(
        options.systemPrompt,
        options.messages,
        reasoning,
      );
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
            ? await this.streamMessage(options, messages, tools, reasoning, requestSignal)
            : await this.nonStreamMessage(options, messages, tools, reasoning, requestSignal);
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

  /**
   * Build the request body honoring the model's capability descriptor.
   * Centralized so both streaming and non-streaming paths agree on the
   * exact shape.
   */
  private buildRequestBody(
    options: CreateMessageOptions,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    reasoning: ReasoningSetting | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const cap = this.capability;
    // Clamp to the model's known output ceiling so a stale catalog value
    // (e.g. 384000 inherited after a hot model switch) can't 400 a
    // smaller-cap model. No known cap → send the value as-is.
    const maxTokens = clampMaxTokens(options.maxTokens ?? this.maxTokens, cap.maxOutputTokens);

    // Token-limit field — capability picks `max_tokens` vs `max_completion_tokens`.
    // Sticky fallback (set by handleApiError on a 400) overrides the rule for
    // ids the regex hasn't learned about yet. When neither a requested value nor
    // a known cap exists, omit the field entirely and let the endpoint apply its
    // own ceiling (rather than inventing 8192 and truncating long outputs).
    const useCompletion =
      this._forceMaxCompletionTokens || cap.tokenLimitField === "max_completion_tokens";
    const tokenLimit: Record<string, number> =
      maxTokens === undefined
        ? {}
        : useCompletion
          ? { max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens };

    // Sampling params — only include if the model accepts them.
    const sampling: Record<string, number> = {};
    if (!cap.rejectedParams.has("temperature")) {
      sampling.temperature =
        options.temperature !== undefined ? options.temperature : this.temperature;
    }

    // Reasoning shape — translate the user's ReasoningSetting to the wire
    // shape. Different vendors, different fields, never combine. We read the
    // real picked level (no "medium" hardcode) — only fall back to "medium"
    // when the setting says "thinking on" but carries no explicit effort
    // ({mode:"on"}).
    const reasoningBody: Record<string, unknown> = {};
    if (reasoning && reasoning.mode !== "off") {
      switch (cap.reasoning.kind) {
        case "deepseek-thinking":
          // DeepSeek V4, Z.AI GLM-4.5+ — top-level {thinking: {type}}.
          // Binary: any non-off means thinking on (effort irrelevant).
          reasoningBody.thinking = { type: "enabled" };
          break;
        case "openai-effort":
          // OpenAI o-series, gpt-5+, Gemini OpenAI-compat, xAI grok-4.3,
          // Mistral magistral, Groq reasoning models — `reasoning_effort`.
          // Send the user's real level; {mode:"on"} (no level) → "medium".
          //
          // Skip entirely once the endpoint has told us `reasoning_effort` is
          // incompatible with `tools` here (see _dropReasoningEffort) — sending
          // it again would just re-trigger the same 400.
          if (!this._dropReasoningEffort) {
            reasoningBody.reasoning_effort =
              reasoning.mode === "effort" ? reasoning.effort : "medium";
          }
          break;
        case "openrouter-reasoning":
          // OpenRouter normalized shape — {reasoning: {effort}}.
          reasoningBody.reasoning =
            reasoning.mode === "effort" ? { effort: reasoning.effort } : { effort: "medium" };
          break;
        case "anthropic-budget":
        case "anthropic-adaptive":
        case "none":
          // OpenAI client doesn't serve Anthropic-direct; nothing to do.
          // `none` means the model doesn't expose a knob — skip silently.
          break;
      }
    } else if (reasoning && reasoning.mode === "off") {
      // Explicit OFF — each shape's "don't think" wire form.
      switch (cap.reasoning.kind) {
        case "deepseek-thinking":
          reasoningBody.thinking = { type: "disabled" };
          break;
        case "openai-effort":
          // The capability's `disabledEffort` (defaults "minimal"; xAI "low",
          // Mistral "none"). Skip if the endpoint already rejected the field.
          if (!this._dropReasoningEffort) {
            reasoningBody.reasoning_effort = cap.reasoning.disabledEffort ?? "minimal";
          }
          break;
        case "openrouter-reasoning":
          reasoningBody.reasoning = { effort: "minimal", exclude: true };
          break;
        default:
          break;
      }
    }

    // reasoning_summary (TODO 7.2): when the model uses the object-form
    // reasoning shape (OpenRouter normalized / Responses-style), attach the
    // requested summary level to that object. For the bare `reasoning_effort`
    // shape there's no summary field on chat-completions, so we skip it rather
    // than send an unknown top-level param.
    if (this.config.reasoningSummary && reasoningBody.reasoning &&
        typeof reasoningBody.reasoning === "object") {
      (reasoningBody.reasoning as Record<string, unknown>).summary =
        this.config.reasoningSummary;
    }

    return {
      model: this.model,
      messages,
      ...tokenLimit,
      ...sampling,
      ...reasoningBody,
      // service_tier (TODO 7.2): passed through verbatim when configured.
      ...(this.config.serviceTier ? { service_tier: this.config.serviceTier } : {}),
      ...(tools ? { tools } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async nonStreamMessage(
    options: CreateMessageOptions,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
    reasoning?: ReasoningSetting,
    requestSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create(
        this.buildRequestBody(
          options,
          messages,
          tools,
          reasoning,
          false,
        ) as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: requestSignal ?? options.signal },
      );

      const choice = response.choices[0];
      if (!choice) throw new LLMError("No response from OpenAI", "openai");

      const usage: TokenUsage = {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      };
      this.recordUsage(usage, options);

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
    reasoning?: ReasoningSetting,
    requestSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    const sdkSignal = requestSignal ?? options.signal;
    try {
      const stream = await this.client.chat.completions.create(
        this.buildRequestBody(
          options,
          messages,
          tools,
          reasoning,
          true,
        ) as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: sdkSignal },
      );

      let text = "";
      let reasoningContent = "";
      const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
      let streamUsage:
        | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        | undefined;
      // Last finish_reason seen on the stream. Without this we returned a
      // hardcoded "stop", so an output-cap cutoff (finish_reason "length")
      // was indistinguishable from a clean finish and the turn loop never
      // ran its max-output continuation. Capture it and return it verbatim.
      let finishReason: string | undefined;

      // TTFT — first chunk that actually carried text. Tool-call-only chunks
      // earlier in the stream don't count: the user-visible "text starts now"
      // moment is what we want to compare across providers.
      const streamStartedAt = Date.now();
      let firstByteLogged = false;

      const requestId = (stream as any).request_id;
      const handleChunk = (chunk: any): string => {
        // Capture usage from the final chunk
        if ((chunk as any).usage) {
          streamUsage = (chunk as any).usage;
        }

        // Capture finish_reason BEFORE the no-delta early return below: the
        // final chunk frequently carries finish_reason with an empty delta.
        const chunkFinish = chunk.choices?.[0]?.finish_reason;
        if (chunkFinish) finishReason = chunkFinish;

        const delta = chunk.choices[0]?.delta;
        if (!delta) return "";

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
          options.onChunk?.({
            type: "text",
            text: delta.content,
            tokens: countTokens(delta.content),
          });
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

        return delta.content ?? "";
      };

      await runStreamWithWatchdog(stream, {
        // Idle watchdog is now ON by default (see STREAM_WATCHDOG_CONFIG) — it
        // catches a stream that connects then stalls mid-generation; the
        // per-request deadline (sdkSignal) catches connect/first-byte hangs.
        idleTimeoutMs: STREAM_WATCHDOG_CONFIG.idleTimeoutMs,
        requestId,
        onChunk: handleChunk,
        signal: sdkSignal,
      });

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
      this.recordUsage(usage, options);

      return {
        text,
        toolCalls,
        usage,
        stopReason: finishReason ?? "stop",
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
    reasoning?: ReasoningSetting,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

    // Drop historical image blocks when the active model can't accept vision.
    // Engine.run only gates *new* attachments; an image left in history from
    // when a vision model was active otherwise re-serializes into `image_url`
    // below and 400s ("unknown variant `image_url`") after a model switch.
    // Identity-preserving on the common path (vision models / no images).
    messages = stripVisionFromHistory(messages, this.capability.supportsVision);

    // Reasoning-content echo-back contract — driven by capability:
    //   "when-tools"  : backfill an empty placeholder if the prior assistant
    //                   turn doesn't carry one (DeepSeek V4 + tools 400s
    //                   otherwise). Skip when thinking is explicitly disabled,
    //                   because empty-string in that mode can degenerate into
    //                   an empty reply on the *next* turn.
    //   "never"       : drop any reasoning_content (deepseek-reasoner 400s
    //                   if input messages contain it).
    //   "optional"    : pass through when we have it, never synthesize.
    const cap = this.capability;
    const hasTools = messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_use" || b.type === "tool_result"),
    );
    const needsReasoningBackfill =
      reasoning?.mode !== "off" &&
      cap.echoReasoning === "when-tools" &&
      hasTools;
    const stripReasoning = cap.echoReasoning === "never";

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

        if (stripReasoning) {
          // Some endpoints (deepseek-reasoner) 400 if reasoning_content
          // appears in input history. Don't attach the field at all.
          reasoningContent = undefined;
        } else if (!reasoningContent && needsReasoningBackfill) {
          reasoningContent = "";
        }
        if (reasoningContent !== undefined) {
          (param as unknown as Record<string, unknown>).reasoning_content = reasoningContent;
        }
        // OpenAI rejects { role: "assistant" } with no content AND no
        // tool_calls ("Invalid assistant message: content or tool_calls
        // must be set"). This shape can arise from a transcript where
        // the assistant produced only reasoning blocks (no text, no tool
        // calls) before the stream was cut off, or from a synthetic
        // message left behind by an interrupted retry. Drop these so
        // the API call doesn't 400 on a structurally-empty turn.
        // reasoning_content alone does NOT satisfy OpenAI's requirement —
        // it's an extension field and not counted as "content".
        if (param.content === undefined && param.tool_calls === undefined) {
          continue;
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
        // and image blocks (P2-6: image input).
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else {
          // Separate tool_result blocks from text/image blocks. tool_result
          // must become its own `role: "tool"` message (OpenAI's wire format
          // doesn't allow tool_result inside a user content array); text and
          // image stay together so the model sees "this text refers to this
          // image" without an intervening tool turn.
          const textParts: string[] = [];
          const imageParts: OpenAI.ChatCompletionContentPart[] = [];
          const toolResults: { tool_use_id: string; content: string }[] = [];

          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              if (typeof block.content === "string") {
                toolResults.push({
                  tool_use_id: block.tool_use_id,
                  content: block.content,
                });
              } else if (Array.isArray(block.content)) {
                // view_image returns an image inside tool_result.content. OpenAI's
                // role:"tool" message can't carry an image, so split it: text stays
                // in the tool message, image blocks are hoisted into imageParts and
                // get emitted as their own user image_url message below.
                const texts: string[] = [];
                for (const inner of block.content) {
                  if (inner.type === "text" && inner.text) {
                    texts.push(inner.text);
                  } else if (inner.type === "image" && inner.source) {
                    const wireDetail = mapImageDetailToOpenAI(this.imageDetail);
                    imageParts.push({
                      type: "image_url",
                      image_url: {
                        url: `data:${inner.source.media_type};base64,${inner.source.data}`,
                        ...(wireDetail ? { detail: wireDetail } : {}),
                      },
                    });
                  }
                }
                toolResults.push({
                  tool_use_id: block.tool_use_id,
                  content: texts.length > 0 ? texts.join("\n") : "[image returned to user message]",
                });
              } else {
                toolResults.push({
                  tool_use_id: block.tool_use_id,
                  content: "",
                });
              }
            } else if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "image" && block.source) {
              // OpenAI-compat image_url: every supported provider (OpenAI,
              // OpenRouter, OpenAI-compatible proxies for Gemini/xAI/etc)
              // accepts a base64 data URL as the URL. Non-vision models never
              // reach here — stripVisionFromHistory() (top of buildMessages)
              // has already swapped their image blocks for text placeholders,
              // and Engine.run rejects *new* attachments to non-vision models.
              //
              // The `detail` hint is honored by OpenAI; OpenAI-compat
              // proxies (OpenRouter for non-OpenAI models, etc.) tolerate
              // the field even when their backend ignores it, so it's
              // safe to always set when settings.images.detail is on.
              // OpenAI's wire only accepts "low" / "high" / "auto"; map
              // our internal "original" (a Codex-style high-fidelity
              // marker) to "high" since OpenAI server-side scales 2048+
              // images anyway.
              const wireDetail = mapImageDetailToOpenAI(this.imageDetail);
              imageParts.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type};base64,${block.source.data}`,
                  ...(wireDetail ? { detail: wireDetail } : {}),
                },
              });
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

          // Emit the user-visible turn. With images present, content MUST be
          // an array — putting a stringified version into `content: "..."`
          // strips the images. Without images we keep the legacy string form
          // so requests for vanilla text turns are byte-identical to before.
          if (imageParts.length > 0) {
            const parts: OpenAI.ChatCompletionContentPart[] = [];
            if (textParts.length > 0) {
              parts.push({ type: "text", text: textParts.join("\n") });
            }
            parts.push(...imageParts);
            result.push({ role: "user", content: parts });
          } else if (textParts.length > 0) {
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
    // User pressed ESC / Stop — the SDK throws APIUserAbortError when
    // the request's AbortSignal fires mid-flight. Rethrow it unchanged
    // so callers up the chain (turn-loop → server.ts) can recognise it
    // as a cancellation rather than a real API failure. Wrapping it
    // into "OpenAI API error: Request was aborted" was surfacing a
    // scary toast for what is, from the user's perspective, "I clicked
    // Stop and it worked."
    if (err instanceof OpenAI.APIUserAbortError) {
      throw err;
    }
    if (err instanceof OpenAI.APIError) {
      if (err.status === 429) {
        throw new LLMRateLimitError("openai");
      }
      const msg = (err.message ?? "").toLowerCase();
      // Some 400s are deterministically self-correctable: we flip a sticky
      // flag that changes the NEXT request body. For those we rethrow a
      // STATUS-LESS LLMError so withRetry's isClientError() check doesn't bail
      // (4xx is normally non-retryable) and the immediate retry goes out with
      // the corrected body — fixing the call that triggered it, not just the
      // next one.
      let selfCorrected = false;

      // o-series / gpt-5+ reject `max_tokens` and demand
      // `max_completion_tokens`. The id-based regex catches the common
      // cases; this is the belt-and-suspenders path for ids that ship
      // before the regex knows about them (e.g. new `gpt-5.x` variants
      // routed via OpenAI-compatible proxies).
      if (
        err.status === 400 &&
        msg.includes("max_tokens") &&
        msg.includes("max_completion_tokens") &&
        !this._forceMaxCompletionTokens
      ) {
        this._forceMaxCompletionTokens = true;
        selfCorrected = true;
      }
      // gpt-5.x: "Function tools with reasoning_effort are not supported for
      // <model> in /v1/chat/completions. Please use /v1/responses instead."
      // Drop reasoning_effort for the lifetime of the client so the retry —
      // and every later tool-calling turn — goes through. We can't switch to
      // /v1/responses here, but tool calls work on /v1/chat/completions as long
      // as reasoning_effort is absent.
      if (
        err.status === 400 &&
        msg.includes("reasoning_effort") &&
        (msg.includes("tools") || msg.includes("/v1/responses")) &&
        !this._dropReasoningEffort
      ) {
        this._dropReasoningEffort = true;
        selfCorrected = true;
      }
      if (selfCorrected) {
        // No status in details → withRetry treats it as retryable and reissues
        // with the now-corrected request body.
        throw new LLMError(`OpenAI API error (auto-correcting): ${err.message}`, "openai");
      }
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
 * Map our internal image-detail enum to the OpenAI wire enum.
 *
 * OpenAI accepts only `low` / `high` / `auto`. We carry an extra
 * `original` value through settings/config to match the Codex
 * concept (preserve client-side dimensions, most expensive), but on
 * the wire it has to collapse to `high` — OpenAI's server scales
 * 2048+ images down regardless, so this is the closest faithful
 * mapping.
 *
 * Returns undefined when the caller didn't set a detail at all, so
 * the OpenAI client uses its own default ("auto", equivalent to
 * "high" today).
 */
function mapImageDetailToOpenAI(
  detail: "low" | "high" | "original" | undefined,
): "low" | "high" | undefined {
  if (!detail) return undefined;
  if (detail === "low") return "low";
  return "high";
}

