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

/** Record the exact Chat Completions wire body for both OpenRouter routes. */
function capturingClient(model: string) {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind: "openrouter",
      model,
      apiKey: "test",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    { retryMaxAttempts: 1 },
    {
      promptCacheHistory: new PromptCacheHistory(),
      auxPromptCacheHistory: new PromptCacheHistory(),
    },
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
    message.content.some((part: any) => part.prompt_cache_breakpoint || part.cache_control)
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
    const scoped = {
      messages: whole,
      promptCache: { scopeId: auxPromptCacheScope("s-1", "p"), scopeKind: "auxiliary" },
    };
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
      promptCache: {
        scopeId: auxPromptCacheScope("s-1", "p"),
        scopeKind: "auxiliary",
        stablePrefixMessageCount: 2,
      },
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

  for (const model of ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5"]) {
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
        build: (count: number, _memories: string[]) =>
          buildSessionMemoryPromptSegments(turns(count)),
      },
    ])(
      `${model} $purpose: later requests mark the previous stable save point`,
      async ({ purpose, system, build }) => {
        const { client, bodies } = capturingClient(model);
        const anthropic = model.startsWith("anthropic/");
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
        expect(breakpoints(one)).toEqual([
          0,
          savePoint,
          ...(anthropic ? [one.messages.length - 1] : []),
        ]);
        expect(breakpoints(two)).toEqual([
          0,
          savePoint,
          second.stable.length,
          ...(anthropic ? [two.messages.length - 1] : []),
        ]);
        expect(second.stable.length).toBeGreaterThan(savePoint);

        // Everything up to the save point is byte-identical on the wire.
        expect(two.messages.slice(0, savePoint + 1)).toEqual(one.messages.slice(0, savePoint + 1));
        if (anthropic) {
          expect(one.prompt_cache_key).toBeUndefined();
          expect(one.prompt_cache_options).toBeUndefined();
        } else {
          expect(one.prompt_cache_key).toBeString();
          expect(two.prompt_cache_key).toBe(one.prompt_cache_key);
          expect(one.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
        }

        // Estimate (characters, not provider tokens) of the share of the second
        // request that precedes the reusable save point.
        const reusable = one.messages
          .slice(0, savePoint + 1)
          .map(wireText)
          .join("").length;
        const total = two.messages.map(wireText).join("").length;
        expect(reusable / total).toBeGreaterThan(0.6);

        const third = await send(24, ["gamma"]);
        expect(breakpoints(bodies[2])).toContain(second.stable.length);
        expect(breakpoints(bodies[2])).toContain(third.stable.length);
        expect(breakpoints(bodies[2])).not.toContain(savePoint);
        expect(breakpoints(bodies[2]).length).toBeLessThanOrEqual(4);
      },
    );
  }
});
