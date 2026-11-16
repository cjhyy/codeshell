import { describe, expect, it } from "bun:test";
import { PromptCacheHistory } from "../prompt-cache.js";
import type { CreateMessageOptions } from "../types.js";
import { OpenAIClient } from "./openai.js";

function fixture(
  model: string,
  histories?: { promptCacheHistory: PromptCacheHistory; auxPromptCacheHistory: PromptCacheHistory },
) {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind: "openrouter",
      model,
      apiKey: "fixture",
      baseUrl: "https://cache-history-fixture.invalid/v1",
    },
    { retryMaxAttempts: 1 },
    histories,
  );
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
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

function request(scopeId: string, auxiliary = false): CreateMessageOptions {
  return {
    systemPrompt: "system",
    messages: [
      { role: "user", content: "settled" },
      { role: "user", content: "tail" },
    ],
    promptCache: {
      scopeId,
      ...(auxiliary ? { scopeKind: "auxiliary" as const } : {}),
      stablePrefixMessageCount: 1,
    },
  };
}

function markedIndexes(body: any): number[] {
  return body.messages.flatMap((message: any, index: number) =>
    message.content?.some?.((part: any) => part.prompt_cache_breakpoint || part.cache_control)
      ? [index]
      : [],
  );
}

describe("OpenAI-compatible auxiliary cache history", () => {
  it("auxiliary scopes cannot evict main history, including after client recreation", async () => {
    const first = fixture("openai/gpt-5.6-sol");
    // A session id's text does not determine its partition.
    const main = request("main:aux:looks-like-an-auxiliary-scope");
    await first.client.createMessage(main);
    for (let index = 0; index < 130; index++) {
      await first.client.createMessage(request(`auxiliary-${index}`, true));
    }
    const resumed = fixture("openai/gpt-5.6-sol");
    main.messages.push({ role: "user", content: "next run" });
    await resumed.client.createMessage(main);
    expect(markedIndexes(resumed.bodies[0])).toEqual([0, 1, 2]);
  });

  it("main traffic cannot evict auxiliary history and each partition retains its cap", async () => {
    const histories = {
      promptCacheHistory: new PromptCacheHistory(1),
      auxPromptCacheHistory: new PromptCacheHistory(1),
    };
    const { client, bodies } = fixture("openai/gpt-5.6-sol", histories);
    const aux = request("auxiliary-retained", true);
    await client.createMessage(aux);
    await client.createMessage(request("main-a"));
    await client.createMessage(request("main-b"));
    aux.messages.push({ role: "user", content: "next run" });
    await client.createMessage(aux);
    expect(markedIndexes(bodies.at(-1))).toEqual([0, 1, 2]);
    const evictedMain = request("main-a");
    evictedMain.messages.push({ role: "user", content: "next run" });
    await client.createMessage(evictedMain);
    expect(markedIndexes(bodies.at(-1))).toEqual([0, 1]);
    await client.createMessage(request("auxiliary-b", true));
    await client.createMessage(aux);
    expect(markedIndexes(bodies.at(-1))).toEqual([0, 1]);
  });

  it("keeps Anthropic's four-marker budget when auxiliary tools consume one slot", async () => {
    const { client, bodies } = fixture("anthropic/claude-sonnet-5", {
      promptCacheHistory: new PromptCacheHistory(),
      auxPromptCacheHistory: new PromptCacheHistory(),
    });
    const aux = request("anthropic-with-tools", true);
    aux.tools = [{ name: "Read", description: "read", inputSchema: { type: "object" } }];
    await client.createMessage(aux);
    aux.messages[1]!.content = "settled extension";
    aux.messages.push({ role: "user", content: "changed tail" });
    aux.promptCache!.stablePrefixMessageCount = 2;
    await client.createMessage(aux);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 2]);
    expect(bodies[1].tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(bodies[1]).split('"cache_control"').length - 1).toBe(4);
  });
});
