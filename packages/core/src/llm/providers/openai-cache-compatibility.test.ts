import { describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

const request: CreateMessageOptions = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "ordinary prompt" }],
  promptCache: { scopeId: "content-fallback", stablePrefixMessageCount: 1 },
};

function fixture(
  model: string,
  endpoint: string,
  error?: { status: number; message: string },
  alwaysReject = false,
) {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind: "openrouter",
      model,
      apiKey: "fixture",
      baseUrl: `https://${endpoint}.invalid/v1`,
    },
    { retryMaxAttempts: 2 },
  );
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
          if (error && (bodies.length === 1 || alwaysReject)) {
            throw new OpenAI.APIError(error.status, error, error.message, undefined);
          }
          return {
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          };
        },
      },
    },
  };
  return { client, bodies };
}

describe("explicit cache content-shape compatibility", () => {
  for (const model of ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5"]) {
    it(`${model} retries string-only content and preserves the fallback across client recreation`, async () => {
      const endpoint = `content-${model.startsWith("anthropic") ? "anthropic" : "openai"}`;
      const { client, bodies } = fixture(model, endpoint, {
        status: 400,
        message: "Invalid type for messages[0].content: expected a string, but got an array",
      });
      await client.createMessage(request);
      await client.createMessage(request);
      expect(bodies).toHaveLength(3);
      expect(Array.isArray(bodies[0].messages[0].content)).toBe(true);
      for (const body of bodies.slice(1)) {
        expect(body.messages).toEqual([
          { role: "system", content: "system" },
          { role: "user", content: "ordinary prompt" },
        ]);
        expect(JSON.stringify(body)).not.toContain("cache_control");
        expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
        expect(body.prompt_cache_options).toBeUndefined();
      }
      const effective = model.startsWith("anthropic") ? "provider-managed" : "openai-implicit";
      expect(client.getEffectivePromptCacheStrategy()).toBe(effective);
      expect(client.getPromptCacheConfigIdentity()).toMatchObject({
        cacheStrategy: effective,
        disableExplicitCacheContent: true,
      });
      const resumed = fixture(model, endpoint);
      expect(resumed.client.getEffectivePromptCacheStrategy()).toBe(effective);
      await resumed.client.createMessage(request);
      expect(resumed.bodies[0].messages).toEqual(bodies[1].messages);
      const otherRoute = fixture(model, `${endpoint}-other`);
      await otherRoute.client.createMessage(request);
      expect(Array.isArray(otherRoute.bodies[0].messages[0].content)).toBe(true);
    });
  }

  for (const [index, message] of [
    "messages[0].content must be a string",
    "Invalid content type for messages[0].content",
  ].entries()) {
    it(`handles supported gateway content wording ${index}`, async () => {
      const { client, bodies } = fixture("openai/gpt-5.6-sol", `content-wording-${index}`, {
        status: 400,
        message,
      });
      await client.createMessage(request);
      expect(bodies).toHaveLength(2);
      expect(bodies[1].messages[0].content).toBe("system");
    });
  }

  for (const [index, error] of [
    { status: 400, message: "Tool argument 'name' must be a string" },
    { status: 400, message: "Invalid content: unsupported image" },
    { status: 422, message: "content must be a string" },
  ].entries()) {
    it(`does not reinterpret unrelated or non-400 API errors ${index}`, async () => {
      const { client, bodies } = fixture("openai/gpt-5.6-sol", `content-negative-${index}`, error);
      await expect(client.createMessage(request)).rejects.toThrow();
      expect(bodies).toHaveLength(1);
      expect(client.getEffectivePromptCacheStrategy()).toBe("openai-hybrid");
    });
  }

  it("makes only one corrective retry when the gateway also rejects string content", async () => {
    const { client, bodies } = fixture(
      "openai/gpt-5.6-sol",
      "content-retry-once",
      { status: 400, message: "content must be a string" },
      true,
    );
    await expect(client.createMessage(request)).rejects.toThrow();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages[0].content).toBe("system");
    expect(client.getEffectivePromptCacheStrategy()).toBe("openai-implicit");
  });
});
