/**
 * Abstract base class for all LLM provider clients.
 */

import type { ClientDefaults, LLMConfig, LLMResponse, TokenUsage } from "../types.js";
import type { CreateMessageOptions, LLMUsageTracker } from "./types.js";
import { LLMError, ContextLimitError, LLMRateLimitError } from "../exceptions.js";
import { logger } from "../logging/logger.js";

function emptyUsageTracker(): LLMUsageTracker {
  return {
    records: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    requestCount: 0,
  };
}

export abstract class LLMClientBase {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number | undefined;
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

  protected usage: LLMUsageTracker = emptyUsageTracker();

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
    // No `?? 8192` fallback: when the model's output ceiling is unknown we keep
    // `undefined` so each provider decides (OpenAI omits the field and lets the
    // endpoint use its own max; Anthropic, where max_tokens is required, supplies
    // a conservative default at request time). Forcing 8192 here truncated long
    // outputs — a streamed tool-arg JSON cut off mid-token → "Missing file_path".
    this.maxTokens = config.maxTokens;
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
    this.usage.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.usage.totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;
    this.usage.requestCount++;
    LLMClientBase.onUsage?.(this.model, usage);
  }

  getUsage(): LLMUsageTracker {
    return { ...this.usage };
  }

  /** Zero all accumulated usage. Used when starting a fresh accounting window
   *  (e.g. after a model switch, where the prior model's cache stats no longer
   *  apply). */
  resetUsage(): void {
    this.usage = emptyUsageTracker();
  }

  /**
   * Compose the caller's AbortSignal with a hard per-request deadline.
   *
   * The provider SDKs accept a `timeout`, but in practice it does NOT fire for
   * a *half-dead socket* (TCP connected, keep-alives flowing, but no response
   * bytes) — we have observed real requests hang 15–33 minutes before the SDK
   * finally surfaced "Socket timeout". The streaming idle-watchdog only covers
   * the gap BETWEEN chunks, not connection setup / first byte, and non-stream
   * calls don't go through it at all. An explicit AbortSignal.timeout is the
   * one mechanism that reliably tears such a request down.
   *
   * Returns a signal to hand the SDK (`{ signal }`) plus a `cleanup()` to clear
   * the timer once the request settles. The deadline is generous (default 2×
   * the SDK timeout, min 120s) — long enough for slow-but-alive generations,
   * short enough that a wedged socket can't burn half an hour.
   */
  protected withRequestDeadline(
    callerSignal?: AbortSignal,
  ): { signal: AbortSignal; cleanup: () => void } {
    const deadlineMs = Math.max(this.timeout * 2, 120_000);
    const deadline = AbortSignal.timeout(deadlineMs);
    // AbortSignal.any is available in Node ≥20 / Bun; combine so EITHER the
    // user's cancel OR the deadline aborts the request.
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline])
      : deadline;
    // AbortSignal.timeout's timer is unref'd by the runtime; no manual clear is
    // strictly required, but expose cleanup for symmetry / future tightening.
    return { signal, cleanup: () => {} };
  }

  protected async withRetry<T>(
    fn: (requestSignal?: AbortSignal) => Promise<T>,
    opts?: { maxAttempts?: number; signal?: AbortSignal },
  ): Promise<T> {
    const attempts = opts?.maxAttempts ?? this.retryMaxAttempts;
    const signal = opts?.signal;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Bail BEFORE issuing (or re-issuing) the request if the run was
      // cancelled. Without this, a cancel that lands during a backoff sleep —
      // or while a flaky connection hangs — still re-fires the same doomed
      // request, so the user's Stop "does nothing" until all attempts +
      // backoffs drain (~50 s for a 3× Connection-error loop). Checking here
      // makes Cancel take effect at the next retry boundary.
      if (signal?.aborted) {
        throw new DOMException("Request cancelled", "AbortError");
      }
      // Per-attempt hard deadline composed with the caller's cancel signal.
      // A half-dead socket that ignores the SDK timeout is torn down here.
      const { signal: requestSignal, cleanup } = this.withRequestDeadline(signal);
      try {
        return await fn(requestSignal);
      } catch (err) {
        lastError = err as Error;

        if (err instanceof ContextLimitError) throw err;

        // Distinguish a deadline tear-down from a user cancel. When the caller
        // did NOT abort but the request signal did, the per-request deadline
        // fired (wedged socket). That is RETRYABLE — fall through to the normal
        // retry/backoff path rather than the abort-no-retry guard below, since
        // the upstream may have just recovered.
        const deadlineFired = !signal?.aborted && requestSignal.aborted;
        if (deadlineFired) {
          logger.warn("llm.request_deadline", {
            cat: "llm",
            provider: this.provider,
            model: this.model,
            attempt,
            of: attempts,
          });
          if (attempt < attempts) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
            if (await abortableSleep(backoff, signal)) {
              throw new DOMException("Request cancelled during retry backoff", "AbortError");
            }
            continue;
          }
          throw new LLMError(
            `request exceeded deadline (${Math.max(this.timeout * 2, 120_000)}ms) — connection wedged`,
            this.provider,
          );
        }

        // User pressed ESC / Stop, or the run's AbortSignal fired. The SDK
        // throws APIUserAbortError (no HTTP status, so isClientError below
        // can't catch it). Retrying re-issues the same aborted request 3×
        // with growing backoff — ~40 s of dead time ending in llm.exhausted,
        // for work the user explicitly cancelled. Surface immediately.
        // Also catch the case where the run aborted but the underlying error
        // surfaced as a generic Connection error (not an SDK abort): the
        // signal is the authoritative "user cancelled" source.
        if (isAbortError(err) || signal?.aborted) {
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
          if (await abortableSleep(waitMs, signal)) {
            throw new DOMException("Request cancelled during retry backoff", "AbortError");
          }
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
        if (await abortableSleep(backoff, signal)) {
          throw new DOMException("Request cancelled during retry backoff", "AbortError");
        }
      }
    }

    throw lastError ?? new LLMError("Unknown LLM error");
  }
}

/**
 * Sleep `ms`, but wake immediately if `signal` aborts. Returns true when it
 * woke due to an abort (caller should bail), false on a normal timeout.
 * Without this an abort during a retry backoff is invisible until the timer
 * fires — the root cause of "Stop does nothing" during a flaky-connection
 * retry loop.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
