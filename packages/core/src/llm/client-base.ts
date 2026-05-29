/**
 * Abstract base class for all LLM provider clients.
 */

import type { ClientDefaults, LLMConfig, LLMResponse, TokenUsage } from "../types.js";
import type { CreateMessageOptions, LLMUsageTracker } from "./types.js";
import { LLMError, ContextLimitError, LLMRateLimitError } from "../exceptions.js";
import { logger } from "../logging/logger.js";

export abstract class LLMClientBase {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly timeout: number;
  readonly retryMaxAttempts: number;
  readonly imageDetail?: ClientDefaults["imageDetail"];

  /**
   * Process-wide hook fired on every LLM response. The CLI installs this in
   * main.ts to feed the cost tracker; lives on the base class so every code
   * path (REPL, run, arena, sub-agents) reports through one funnel without
   * each call site needing to remember.
   */
  static onUsage?: (model: string, usage: TokenUsage) => void;

  protected usage: LLMUsageTracker = {
    records: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };

  /**
   * `config` carries model identity (provider/model/apiKey/baseUrl/maxTokens/
   * thinking/providerKind). `defaults` carries cross-model runtime knobs
   * (temperature/timeout/retryMaxAttempts/imageDetail) — those are owned by
   * the Engine and stay stable across hot model switches.
   */
  constructor(
    protected readonly config: LLMConfig,
    defaults?: ClientDefaults,
  ) {
    this.provider = config.provider;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.temperature = defaults?.temperature ?? 0.3;
    this.timeout = defaults?.timeout ?? 120_000;
    this.retryMaxAttempts = defaults?.retryMaxAttempts ?? 3;
    this.imageDetail = defaults?.imageDetail;
    this.initClient();
  }

  protected abstract initClient(): void;

  abstract createMessage(options: CreateMessageOptions): Promise<LLMResponse>;

  protected recordUsage(usage: TokenUsage, options?: CreateMessageOptions): void {
    if (options?.recordUsage === false) return;
    this.usage.records.push(usage);
    this.usage.totalPromptTokens += usage.promptTokens;
    this.usage.totalCompletionTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
    this.usage.requestCount++;
    LLMClientBase.onUsage?.(this.model, usage);
  }

  getUsage(): LLMUsageTracker {
    return { ...this.usage };
  }

  protected async withRetry<T>(fn: () => Promise<T>, maxAttempts?: number): Promise<T> {
    const attempts = maxAttempts ?? this.retryMaxAttempts;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;

        if (err instanceof ContextLimitError) throw err;

        if (err instanceof LLMRateLimitError) {
          const waitMs = (err.retryAfter ?? attempt * 2) * 1000;
          logger.warn("llm.retry", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            attempt,
            of: attempts,
            reason: "rate_limit",
            waitMs,
          });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        // 4xx (except 429, handled above as LLMRateLimitError) is a
        // deterministic client-side mistake — bad message sequence,
        // unauthorized, model not found, prompt too long. Retrying
        // gives the same answer 3 times with growing backoff and
        // burns ~9 s of user time. Surface immediately.
        if (isClientError(err)) {
          logger.warn("llm.client_error_no_retry", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            status: (err as { status?: number }).status,
            error: (err as Error).message,
          });
          throw err;
        }

        if (attempt === attempts) {
          logger.error("llm.exhausted", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            attempts,
            error: (err as Error).message,
          });
          break;
        }

        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
        logger.warn("llm.retry", {
          cat: "llm",
          provider: this.provider,
          model: this.model,
          attempt,
          of: attempts,
          reason: "error",
          error: (err as Error).message,
          backoffMs: backoff,
        });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw lastError ?? new LLMError("Unknown LLM error");
  }
}

/**
 * Detect HTTP 4xx errors from provider SDKs so withRetry can bail
 * without burning backoff time. OpenAI/Anthropic SDKs both attach a
 * numeric `status` to their error objects; we treat 400-499 as
 * non-retryable (429 is handled separately above as a rate-limit).
 *
 * Network errors and 5xx fall through and remain retryable.
 */
function isClientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number") return false;
  if (status === 429) return false;
  return status >= 400 && status < 500;
}
