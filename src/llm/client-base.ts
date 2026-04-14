/**
 * Abstract base class for all LLM provider clients.
 */

import type { LLMConfig, LLMResponse, TokenUsage } from "../types.js";
import type { CreateMessageOptions, LLMUsageTracker } from "./types.js";
import { LLMError, ContextLimitError, LLMRateLimitError } from "../exceptions.js";

export abstract class LLMClientBase {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeout: number;
  readonly retryMaxAttempts: number;
  readonly enableStreaming: boolean;

  protected usage: LLMUsageTracker = {
    records: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    requestCount: 0,
  };

  constructor(protected readonly config: LLMConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.temperature = config.temperature ?? 0.3;
    this.maxTokens = config.maxTokens ?? 8192;
    this.timeout = config.timeout ?? 120_000;
    this.retryMaxAttempts = config.retryMaxAttempts ?? 3;
    this.enableStreaming = config.enableStreaming ?? true;
    this.initClient();
  }

  protected abstract initClient(): void;

  abstract createMessage(options: CreateMessageOptions): Promise<LLMResponse>;

  protected recordUsage(usage: TokenUsage): void {
    this.usage.records.push(usage);
    this.usage.totalPromptTokens += usage.promptTokens;
    this.usage.totalCompletionTokens += usage.completionTokens;
    this.usage.totalTokens += usage.totalTokens;
    this.usage.requestCount++;
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
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (attempt === attempts) break;

        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw lastError ?? new LLMError("Unknown LLM error");
  }
}
