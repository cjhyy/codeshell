import { describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

function capturingClient(model = "gpt-5.6-sol", providerKind = "openai") {
  const bodies: any[] = [];
  const client = new OpenAIClient({
    provider: "openai",
    providerKind,
    model,
    apiKey: "test",
    baseUrl:
      providerKind === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
  });
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(body);
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

function options(scopeId = "s-cache"): CreateMessageOptions {
  return {
    systemPrompt: "stable system",
    messages: [
      { role: "user", content: "stable history" },
      { role: "user", content: "volatile git status" },
      { role: "assistant", content: "rolling tail" },
    ],
    promptCache: { scopeId, stablePrefixMessageCount: 1 },
    stream: false,
  };
}

function explicitMarkers(body: any): any[] {
  return body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content.filter((part: any) => part.prompt_cache_breakpoint)
      : [],
  );
}

describe("OpenAIClient prompt caching", () => {
  it("sends GPT-5.6 explicit options, an opaque session key, and three prefix boundaries", async () => {
    const { client, bodies } = capturingClient();
    await client.createMessage(options());

    const body = bodies[0];
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(body.prompt_cache_key).toMatch(/^cs:[a-f0-9]{48}$/);
    expect(explicitMarkers(body)).toHaveLength(3);
    for (const marker of explicitMarkers(body)) {
      expect(marker.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    }
  });

  it("keeps the key stable within a session and isolates different sessions", async () => {
    const { client, bodies } = capturingClient();
    await client.createMessage(options("same"));
    await client.createMessage(options("same"));
    await client.createMessage(options("different"));
    expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
    expect(bodies[2].prompt_cache_key).not.toBe(bodies[0].prompt_cache_key);
  });

  it("uses only affinity for older OpenAI models", async () => {
    const { client, bodies } = capturingClient("gpt-5.5");
    await client.createMessage(options());
    expect(bodies[0].prompt_cache_key).toMatch(/^cs:/);
    expect(bodies[0].prompt_cache_options).toBeUndefined();
    expect(explicitMarkers(bodies[0])).toEqual([]);
  });

  it("retries and downgrades sticky to implicit mode when a gateway rejects explicit fields", async () => {
    const { client, bodies } = capturingClient("openai/gpt-5.6-sol", "openrouter");
    let attempts = 0;
    (client as any)._client.chat.completions.create = async (body: any) => {
      bodies.push(body);
      attempts++;
      if (attempts === 1) {
        throw new OpenAI.APIError(
          400,
          { message: "Unknown parameter: prompt_cache_options" },
          "Unknown parameter: prompt_cache_options",
          undefined,
        );
      }
      return {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      };
    };

    await client.createMessage(options());

    expect(bodies).toHaveLength(2);
    expect(bodies[0].prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(bodies[1].prompt_cache_options).toBeUndefined();
    expect(explicitMarkers(bodies[1])).toEqual([]);
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    expect(client.getPromptCacheConfigIdentity()).toMatchObject({
      cacheStrategy: "openai-implicit",
      disableExplicitPromptCache: true,
    });
  });
});
