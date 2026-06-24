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

  it("per-request temperature overrides a static extraBody temperature (review #4)", async () => {
    // extraBody (connection-level static) sets temperature 0.2; the caller
    // passes a per-request temperature 0.9. The per-request value must win —
    // the old `...sampling, ...extra` order let the static value clobber it.
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
      extraBody: { temperature: 0.2, top_p: 0.95 },
    });

    await client.createMessage({ ...opts, temperature: 0.9 });

    const body = bodies()[0];
    expect(body.temperature).toBe(0.9); // per-request wins
    expect(body.top_p).toBe(0.95); // static extra still rides through
  });

  it("deep-merges nested keys shared by extraBody and the reasoning body (review #5)", async () => {
    // A catalog param wired to `thinking.budget_tokens` lands in extraBody as a
    // nested object; the reasoning translation may also set `thinking`. A shallow
    // spread would wholesale-replace one — deep merge keeps both nested fields.
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
      extraBody: { thinking: { budget_tokens: 4096 }, seed: 7 },
    });

    await client.createMessage(opts);

    const body = bodies()[0];
    // the nested field from extraBody survives (not replaced by an empty/other
    // thinking object), and the sibling key rides through.
    expect(body.thinking).toMatchObject({ budget_tokens: 4096 });
    expect(body.seed).toBe(7);
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
