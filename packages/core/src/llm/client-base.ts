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

        // User pressed ESC / Stop, or the run's AbortSignal fired. The SDK
        // throws APIUserAbortError (no HTTP status, so isClientError below
        // can't catch it). Retrying re-issues the same aborted request 3×
        // with growing backoff — ~40 s of dead time ending in llm.exhausted,
        // for work the user explicitly cancelled. Surface immediately.
        if (isAbortError(err)) {
          logger.warn("llm.abort_no_retry", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            error: (err as Error).message,
          });
          throw err;
        }

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
 * without burning backoff time. OpenAI/Anthropic SDKs attach a numeric
 * `status` to their error objects; we treat 400-499 as non-retryable
 * (429 is handled separately above as a rate-limit).
 *
 * The provider clients also wrap SDK errors into `new LLMError(msg,
 * provider, { status })`, where the status lands in
 * `FrameworkError.details.status` rather than a top-level `.status`.
 * We read both so a wrapped 400/401/404 isn't retried 3× (~9 s wasted)
 * before finally surfacing.
 *
 * Network errors and 5xx fall through and remain retryable.
 *
 * Exported for unit testing.
 */
export function isClientError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const top = (err as { status?: unknown }).status;
  const buried = (err as { details?: { status?: unknown } }).details?.status;
  const status = typeof top === "number" ? top : typeof buried === "number" ? buried : undefined;
  if (typeof status !== "number") return false;
  if (status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Detect a user/run cancellation. The OpenAI and Anthropic SDKs throw
 * `APIUserAbortError` when a request's AbortSignal fires mid-flight; the
 * providers rethrow it unchanged (see handleApiError). It carries no HTTP
 * `status`, so `isClientError` can't recognise it — without an explicit
 * check it falls through to `withRetry`'s generic branch and gets retried.
 *
 * We match by error name rather than `instanceof` to avoid importing the
 * provider SDKs into the base class: `APIUserAbortError` from the SDKs, and
 * the WHATWG `AbortError` from `fetch`/AbortController, both surface here.
 *
 * Exported for unit testing.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "APIUserAbortError" || name === "AbortError";
}
