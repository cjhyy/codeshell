import { describe, expect, test } from "bun:test";
import { OpenAIClient } from "../llm/providers/openai.js";
import { PromptCacheHistory } from "../llm/prompt-cache.js";
import type { CreateMessageOptions } from "../llm/types.js";
import { buildExtractionPromptSegments } from "../services/extract-memories.js";
import { buildSessionMemoryPromptSegments } from "../services/session-memory.js";
import { joinMemoryPrompt, type MemoryPromptSegments } from "../services/memory-prompt-segments.js";
import {
  SESSION_TRANSCRIPT_SYSTEM_PROMPT,
  sessionTranscriptCachePlan,
} from "../services/session-transcript-prompt.js";
import { auxCachedRequest, auxPromptCacheScope } from "../llm/aux-prompt-cache.js";

function turns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `TURN_${index} ${"x".repeat(900)}`,
    endsTurn: index % 2 === 1,
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
      auxPromptCacheScope("s-1", "session-transcript"),
      auxPromptCacheScope("s-1", "memory-write-decision"),
      auxPromptCacheScope("s-2", "session-transcript"),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  for (const model of ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5"]) {
    const anthropic = model.startsWith("anthropic/");
    const extraction = (count: number, memories: string[]) =>
      buildExtractionPromptSegments(
        turns(count),
        memories.map((name) => ({ name, type: "project", description: `${name} text` })),
      );
    const summary = (count: number) => buildSessionMemoryPromptSegments(turns(count));
    const sender = (client: OpenAIClient) => async (segments: MemoryPromptSegments) => {
      const request: CreateMessageOptions = {
        systemPrompt: SESSION_TRANSCRIPT_SYSTEM_PROMPT,
        ...auxCachedRequest({
          client,
          sessionId: "s-1",
          prompt: joinMemoryPrompt(segments),
          plan: sessionTranscriptCachePlan(segments),
        }),
        tools: [],
        maxTokens: 3072,
        reasoning: { mode: "off" },
      };
      await client.createMessage(request);
      return segments;
    };

    test(`${model}: the summary reads the extraction's prefix, up to the transcript end`, async () => {
      const { client, bodies } = capturingClient(model);
      const send = sender(client);
      const first = await send(extraction(14, ["alpha"]));
      await send(summary(14));
      const [one, two] = bodies;

      // Wire index 0 is the system message, so the last stable message of a
      // request with K stable messages sits at wire index K: the transcript end.
      const savePoint = first.stable.length;
      expect(wireText(one.messages[savePoint])).toEndWith(`TURN_13 ${"x".repeat(900)}`);
      expect(two.messages.slice(0, savePoint + 1)).toEqual(one.messages.slice(0, savePoint + 1));
      expect(wireText(one.messages.at(-1))).not.toBe(wireText(two.messages.at(-1)));

      // Both carry the save point at the transcript end (the summary's read
      // point is the same index); Anthropic also marks its rolling tail.
      for (const body of [one, two]) {
        expect(breakpoints(body)).toEqual([
          0,
          savePoint,
          ...(anthropic ? [body.messages.length - 1] : []),
        ]);
      }
      if (anthropic) {
        expect(one.prompt_cache_key).toBeUndefined();
        expect(two.prompt_cache_key).toBeUndefined();
      } else {
        // OpenAI caches per prompt_cache_key: one key per session, for both calls.
        expect(one.prompt_cache_key).toBeString();
        expect(two.prompt_cache_key).toBe(one.prompt_cache_key);
        expect(two.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
      }
      expect(one.max_tokens ?? one.max_completion_tokens).toBe(
        two.max_tokens ?? two.max_completion_tokens,
      );
    });

    test(`${model}: the next run marks the previous run's save point`, async () => {
      const { client, bodies } = capturingClient(model);
      const send = sender(client);
      await send(extraction(14, ["alpha"]));
      const first = await send(summary(14));
      const second = await send(extraction(18, ["beta", "alpha"]));
      const [, one, two] = bodies;

      const savePoint = first.stable.length;
      expect(second.stable.length).toBeGreaterThan(savePoint);
      expect(breakpoints(two)).toEqual([
        0,
        savePoint,
        second.stable.length,
        ...(anthropic ? [two.messages.length - 1] : []),
      ]);
      // Everything up to the save point is byte-identical on the wire,
      // across purposes as well as runs.
      expect(two.messages.slice(0, savePoint + 1)).toEqual(one.messages.slice(0, savePoint + 1));
      if (!anthropic) expect(two.prompt_cache_key).toBe(one.prompt_cache_key);

      // Estimate (characters, not provider tokens) of the share of the second
      // request that precedes the reusable save point.
      const reusable = one.messages
        .slice(0, savePoint + 1)
        .map(wireText)
        .join("").length;
      const total = two.messages.map(wireText).join("").length;
      expect(reusable / total).toBeGreaterThan(0.6);

      const third = await send(summary(24));
      expect(breakpoints(bodies[3])).toContain(second.stable.length);
      expect(breakpoints(bodies[3])).toContain(third.stable.length);
      expect(breakpoints(bodies[3])).not.toContain(savePoint);
      expect(breakpoints(bodies[3]).length).toBeLessThanOrEqual(4);
    });
  }
});
