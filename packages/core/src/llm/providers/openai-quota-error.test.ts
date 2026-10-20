import { describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import { LLMRateLimitError } from "../../exceptions.js";
import { friendlyError } from "../../engine/friendly-error.js";

function clientThrowing(error: unknown): { client: OpenAIClient; calls: () => number } {
  const client = new OpenAIClient({ provider: "openai", model: "gpt-4o", apiKey: "test" });
  let calls = 0;
  (client as any)._client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          throw error;
        },
      },
    },
  };
  return { client, calls: () => calls };
}

const request = {
  systemPrompt: "system",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  stream: false,
};

describe("OpenAIClient HTTP 429 classification", () => {
  it("keeps a billing/quota 429 as a non-retryable quota error with its cause", async () => {
    const quota = OpenAI.APIError.generate(
      429,
      {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
      undefined,
      new Headers(),
    );
    const { client, calls } = clientThrowing(quota);

    const err = await client.createMessage(request).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LLMRateLimitError);
    expect((err as Error).message).toContain("exceeded your current quota");
    expect(calls()).toBe(1);
    expect(friendlyError(err).message).toContain("billing/quota");
  });

  it("still maps a throttling 429 to a rate-limit error", async () => {
    const throttled = OpenAI.APIError.generate(
      429,
      { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } },
      undefined,
      new Headers(),
    );
    const client = new OpenAIClient({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test",
    });
    expect(() => (client as any).handleApiError(throttled)).toThrow(LLMRateLimitError);
  });
});
