import { describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import { PromptCacheHistory } from "../prompt-cache.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * The rejection is remembered per route for the whole process, so these
 * routes use an endpoint no other suite sharing the process uses.
 */
const STRING_ONLY_GATEWAY = "https://string-only-gateway.fixture.invalid/v1";

/** A fake transport: a gateway that accepts only string message content. */
function stringOnlyGateway(settings: { model: string; providerKind: string; baseUrl: string }) {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    { provider: "openai", apiKey: "test", ...settings } as never,
    { retryMaxAttempts: 2 },
    { promptCacheHistory: new PromptCacheHistory() },
  );
  let rejection = "Invalid type for 'messages[1].content': expected a string, got an array";
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
          if (body.messages.some((message: any) => Array.isArray(message.content)))
            throw new OpenAI.APIError(400, { message: rejection }, rejection, undefined);
          return {
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
          };
        },
      },
    },
  };
  return {
    client,
    bodies,
    rejectWith(message: string) {
      rejection = message;
    },
  };
}

function request(): CreateMessageOptions {
  return {
    systemPrompt: "stable system",
    messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next task" },
    ],
    promptCache: { scopeId: "scope", stablePrefixMessageCount: 2 },
    stream: false,
  };
}

const plain = (body: any) => body.messages.every((m: any) => typeof m.content === "string");

describe("text-part array content rejected by a gateway", () => {
  it("anthropic-explicit: retries once with plain strings and stays there", async () => {
    const { client, bodies } = stringOnlyGateway({
      model: "anthropic/claude-sonnet-4.5",
      providerKind: "openrouter",
      baseUrl: STRING_ONLY_GATEWAY,
    });
    expect(client.getEffectivePromptCacheStrategy()).toBe("anthropic-explicit");
    expect((await client.createMessage(request())).text).toBe("done");
    expect(bodies).toHaveLength(2);
    expect(plain(bodies[0])).toBe(false);
    expect(plain(bodies[1])).toBe(true);
    // Sticky for the client, and reported as the strategy now in effect.
    expect(client.getEffectivePromptCacheStrategy()).toBe("provider-managed");
    expect(client.getPromptCacheConfigIdentity()).toMatchObject({ plainStringContent: true });
    await client.createMessage(request());
    expect(bodies).toHaveLength(3);
    expect(plain(bodies[2])).toBe(true);
    expect(JSON.stringify(bodies[2])).not.toContain("cache_control");
    // Clients are created per run: a later client of the route starts plain.
    const later = stringOnlyGateway({
      model: "anthropic/claude-sonnet-4.5",
      providerKind: "openrouter",
      baseUrl: STRING_ONLY_GATEWAY,
    });
    expect(later.client.getEffectivePromptCacheStrategy()).toBe("provider-managed");
    await later.client.createMessage(request());
    expect(later.bodies).toHaveLength(1);
    expect(plain(later.bodies[0])).toBe(true);
  });

  it("openai-hybrid: falls back to implicit caching and keeps the affinity key", async () => {
    const { client, bodies } = stringOnlyGateway({
      model: "openai/gpt-5.6-sol",
      providerKind: "openrouter",
      baseUrl: STRING_ONLY_GATEWAY,
    });
    expect(client.getEffectivePromptCacheStrategy()).toBe("openai-hybrid");
    await client.createMessage(request());
    expect(bodies).toHaveLength(2);
    expect(plain(bodies[1])).toBe(true);
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    expect(bodies[1].prompt_cache_options).toBeUndefined();
    expect(JSON.stringify(bodies[1])).not.toContain("prompt_cache_breakpoint");
    expect(client.getEffectivePromptCacheStrategy()).toBe("openai-implicit");
  });

  it("an unrelated 400 that mentions content does not change the content shape", async () => {
    // Routes are remembered for the process: use one no other test here rejected.
    const { client, bodies, rejectWith } = stringOnlyGateway({
      model: "anthropic/claude-haiku-4.5",
      providerKind: "openrouter",
      baseUrl: STRING_ONLY_GATEWAY,
    });
    rejectWith("The prompt was filtered by the content management policy");
    await expect(client.createMessage(request())).rejects.toThrow("content management policy");
    expect(bodies).toHaveLength(1);
    expect(client.getEffectivePromptCacheStrategy()).toBe("anthropic-explicit");
  });

  it("a rejected cache field is left to the cache-field fallback", async () => {
    const { client, rejectWith } = stringOnlyGateway({
      model: "gpt-5.6-sol",
      providerKind: "openai",
      baseUrl: STRING_ONLY_GATEWAY,
    });
    rejectWith("Unknown parameter: messages[1].content[0].prompt_cache_breakpoint");
    // Implicit caching sends plain strings, so the retry goes through.
    await client.createMessage(request());
    expect(client.getPromptCacheConfigIdentity()).toMatchObject({
      plainStringContent: false,
      disableExplicitPromptCache: true,
    });
  });
});
