import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * P1 generic param passthrough: catalog-driven `paramValues` get wire-mapped
 * into `LLMConfig.extraBody` (Tasks 1-2). The OpenAI client must inject those
 * keys into the request body, filtered per-key by the model's
 * `rejectedParams` (same contract as the built-in `sampling.temperature`).
 */

/** Stub that records each request body and always succeeds. */
function clientThatSucceeds(
  config: ConstructorParameters<typeof OpenAIClient>[0],
): { client: OpenAIClient; bodies: () => any[] } {
  const bodies: any[] = [];
  const client = new OpenAIClient(config);
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          bodies.push(b);
          return {
            id: "x",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  return { client, bodies: () => bodies };
}

const opts: CreateMessageOptions = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

describe("OpenAIClient extraBody passthrough", () => {
  it("injects every extraBody key into the request body", async () => {
    // gpt-4o accepts classic sampling params (temperature/top_p not rejected).
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
      extraBody: { temperature: 0.7, top_p: 0.95, thinking: { type: "enabled" } },
    });

    const resp = await client.createMessage(opts);
    expect(resp.text).toBe("done");

    const body = bodies()[0];
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.95);
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("filters out any extraBody key the model rejects (temperature on gpt-5)", async () => {
    // gpt-5 rejects `temperature` (rejectedParams) — even though extraBody
    // carries it, the body must NOT include it. top_p is also rejected; a
    // non-rejected key like `seed` still rides through.
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
      extraBody: { temperature: 0.7, top_p: 0.95, seed: 42 },
    });

    await client.createMessage(opts);

    const body = bodies()[0];
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.seed).toBe(42);
  });
});
