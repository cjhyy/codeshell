import { describe, expect, test } from "bun:test";
import { OpenAIClient } from "../llm/providers/openai.js";
import { PromptCacheHistory } from "../llm/prompt-cache.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { buildExtractionPromptSegments } from "../services/extract-memories.js";
import { buildSessionMemoryPromptSegments } from "../services/session-memory.js";
import { joinMemoryPrompt } from "../services/memory-prompt-segments.js";
import { auxCachedRequest, auxPromptCacheScope } from "./aux-prompt-cache.js";

function turns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `TURN_${index} ${"x".repeat(900)}`,
  }));
}

/** An OpenRouter GPT route (openai-hybrid) that records request bodies. */
function capturingClient() {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind: "openrouter",
      model: "openai/gpt-5.6-sol",
      apiKey: "test",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    { retryMaxAttempts: 1 },
    { promptCacheHistory: new PromptCacheHistory() },
  );
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
          return {
            choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
          };
        },
      },
    },
  };
  return { client, bodies };
}

function breakpoints(body: any): number[] {
  return body.messages.flatMap((message: any, index: number) =>
    Array.isArray(message.content) &&
    message.content.some((part: any) => part.prompt_cache_breakpoint)
      ? [index]
      : [],
  );
}

const wireText = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => part.text).join("");

describe("auxiliary prompt cache request", () => {
  const marking = { getPromptCacheConfigIdentity: () => ({ cacheStrategy: "openai-hybrid" }) };
  const whole = [{ role: "user", content: "whole prompt" }];

  test("without a plan the request is the single message with no cache context", () => {
    expect(auxCachedRequest({ client: marking, sessionId: "s-1", prompt: "whole prompt" })).toEqual(
      { messages: whole },
    );
  });

  test("a client that places no markers, or a plan with nothing stable, keeps one message", () => {
    const plan = { purpose: "p", stable: ["a", "b"], volatile: "v" };
    const scoped = { messages: whole, promptCache: { scopeId: auxPromptCacheScope("s-1", "p") } };
    for (const client of [
      {},
      { getPromptCacheConfigIdentity: () => ({ cacheStrategy: "provider-managed" }) },
      { getPromptCacheConfigIdentity: () => ({ cacheStrategy: "openai-implicit" }) },
    ]) {
      expect(auxCachedRequest({ client, sessionId: "s-1", prompt: "whole prompt", plan })).toEqual(
        scoped,
      );
    }
    expect(
      auxCachedRequest({
        client: marking,
        sessionId: "s-1",
        prompt: "whole prompt",
        plan: { ...plan, stable: [] },
      }),
    ).toEqual(scoped);
    expect(
      auxCachedRequest({ client: marking, sessionId: "s-1", prompt: "whole prompt", plan }),
    ).toEqual({
      messages: ["a", "b", "v"].map((content) => ({ role: "user", content })),
      promptCache: { scopeId: auxPromptCacheScope("s-1", "p"), stablePrefixMessageCount: 2 },
    });
  });

  test("scopes differ per session and purpose and never equal the session scope", () => {
    const scopes = [
      "s-1",
      auxPromptCacheScope("s-1", "memory-extraction"),
      auxPromptCacheScope("s-1", "session-summary"),
      auxPromptCacheScope("s-2", "memory-extraction"),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  test.each([
    {
      purpose: "memory-extraction" as const,
      system: "You are a memory extraction assistant.",
      build: (count: number, memories: string[]) =>
        buildExtractionPromptSegments(
          turns(count),
          memories.map((name) => ({ name, type: "project", description: `${name} text` })),
        ),
    },
    {
      purpose: "session-summary" as const,
      system: "You are a session summariser. Output only valid JSON.",
      build: (count: number, _memories: string[]) => buildSessionMemoryPromptSegments(turns(count)),
    },
  ])(
    "$purpose: the second run's wire request marks the first run's save point",
    async ({ purpose, system, build }) => {
      const { client, bodies } = capturingClient();
      const send = async (count: number, memories: string[]) => {
        const segments = build(count, memories);
        const request: CreateMessageOptions = {
          systemPrompt: system,
          ...auxCachedRequest({
            client,
            sessionId: "s-1",
            prompt: joinMemoryPrompt(segments),
            plan: { purpose, ...segments },
          }),
          tools: [],
          maxTokens: 3072,
          reasoning: { mode: "off" },
        };
        await client.createMessage(request);
        return segments;
      };

      const first = await send(14, ["alpha"]);
      const second = await send(18, ["beta", "alpha"]);
      const [one, two] = bodies;

      // Wire index 0 is the system message, so the last stable message of a
      // request with K stable messages sits at wire index K.
      const savePoint = first.stable.length;
      expect(breakpoints(one)).toEqual([0, savePoint]);
      expect(breakpoints(two)).toEqual([0, savePoint, second.stable.length]);
      expect(second.stable.length).toBeGreaterThan(savePoint);

      // Everything up to the save point is byte-identical on the wire.
      expect(two.messages.slice(0, savePoint + 1).map(wireText)).toEqual(
        one.messages.slice(0, savePoint + 1).map(wireText),
      );
      expect(one.prompt_cache_key).toBeString();
      expect(two.prompt_cache_key).toBe(one.prompt_cache_key);
      expect(one.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });

      // Estimate (characters, not provider tokens) of the share of the second
      // request that precedes the reusable save point.
      const reusable = one.messages
        .slice(0, savePoint + 1)
        .map(wireText)
        .join("").length;
      const total = two.messages.map(wireText).join("").length;
      expect(reusable / total).toBeGreaterThan(0.6);
    },
  );
});
