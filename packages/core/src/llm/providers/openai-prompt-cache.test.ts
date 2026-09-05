import { describe, expect, it } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import { PromptCacheHistory } from "../prompt-cache.js";
import type { CreateMessageOptions } from "../types.js";

function completion() {
  return {
    choices: [
      {
        message: { role: "assistant", content: "done" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
  };
}

function streamCompletion(): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "done" } }] };
      yield {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: completion().usage,
      };
    },
  };
}

function capturingClient(
  settings: {
    model?: string;
    providerKind?: string;
    baseUrl?: string;
    history?: PromptCacheHistory;
    retryMaxAttempts?: number;
  } = {},
) {
  const bodies: any[] = [];
  const providerKind = settings.providerKind ?? "openai";
  const client = new OpenAIClient(
    {
      provider: "openai",
      providerKind,
      model: settings.model ?? "gpt-5.6-sol",
      apiKey: "test",
      baseUrl:
        settings.baseUrl ??
        (providerKind === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1"),
    },
    { retryMaxAttempts: settings.retryMaxAttempts ?? 1 },
    { promptCacheHistory: settings.history ?? new PromptCacheHistory() },
  );
  let respond: (body: any) => unknown | Promise<unknown> = (body) =>
    body.stream ? streamCompletion() : completion();
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
          return respond(body);
        },
      },
    },
  };
  return {
    client,
    bodies,
    respondWith(handler: typeof respond) {
      respond = handler;
    },
  };
}

function options(scopeId = "s-cache"): CreateMessageOptions {
  return {
    systemPrompt: "stable system",
    messages: [
      { role: "user", content: "stable history" },
      { role: "user", content: "volatile git status" },
    ],
    promptCache: { scopeId, stablePrefixMessageCount: 1 },
    stream: false,
  };
}

function appendUserTurn(request: CreateMessageOptions, text: string): void {
  request.messages.push({ role: "assistant", content: "done" }, { role: "user", content: text });
}

function appendToolBatch(request: CreateMessageOptions, ids: string[]): void {
  request.messages.push(
    {
      role: "assistant",
      content: ids.map((id) => ({
        type: "tool_use",
        id,
        name: "Read",
        input: { path: id },
      })),
    },
    {
      role: "user",
      content: [...ids].reverse().map((id) => ({
        // Results may arrive out of order; the provider restores tool-call order.
        type: "tool_result",
        tool_use_id: id,
        content: `result for ${id}`,
      })),
    },
  );
}

function explicitMarkers(body: any): any[] {
  return body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content.filter((part: any) => part.prompt_cache_breakpoint)
      : [],
  );
}

function markedIndexes(body: any): number[] {
  return body.messages.flatMap((message: any, index: number) =>
    Array.isArray(message.content) &&
    message.content.some((part: any) => part.prompt_cache_breakpoint)
      ? [index]
      : [],
  );
}

function canonicalMessages(body: any): any[] {
  return body.messages.map((message: any) => ({
    ...message,
    ...(Array.isArray(message.content) && message.content.every((part: any) => part.type === "text")
      ? { content: message.content.map((part: any) => part.text).join("") }
      : {}),
  }));
}

describe("OpenAIClient prompt caching", () => {
  it("uses an implicit tail and at most three explicit boundaries for GPT-5.6", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    await client.createMessage(request);
    appendUserTurn(request, "next question");
    await client.createMessage(request);
    for (const body of bodies) {
      expect(body.prompt_cache_options).toEqual({
        mode: "implicit",
        ttl: "30m",
      });
      expect(body.prompt_cache_key).toMatch(/^cs:[a-f0-9]{48}$/);
      expect(explicitMarkers(body).length).toBeLessThanOrEqual(3);
      for (const marker of explicitMarkers(body)) {
        expect(marker.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
      }
    }
    expect(markedIndexes(bodies[0])).toEqual([0, 1]);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 2]);
    expect(bodies[1].messages[4].content).toBe("next question");
  });

  it("retains the previous successful user boundary across three append-only requests", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    const original = structuredClone(request.messages);
    await client.createMessage(request);
    appendUserTurn(request, "second question");
    await client.createMessage(request);
    appendUserTurn(request, "third question");
    await client.createMessage(request);
    expect(markedIndexes(bodies[0])).toEqual([0, 1]);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 2]);
    expect(markedIndexes(bodies[2])).toEqual([0, 1, 4]);
    expect(canonicalMessages(bodies[1]).slice(0, bodies[0].messages.length)).toEqual(
      canonicalMessages(bodies[0]),
    );
    expect(canonicalMessages(bodies[2]).slice(0, bodies[1].messages.length)).toEqual(
      canonicalMessages(bodies[1]),
    );
    expect(request.messages.slice(0, original.length)).toEqual(original);
  });

  it("keeps the last wire tool result of the prior parallel batch as the read boundary", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    appendToolBatch(request, ["first-a", "first-b"]);
    await client.createMessage(request);
    appendToolBatch(request, ["second-a", "second-b", "second-c"]);
    await client.createMessage(request);
    expect(request.messages).toHaveLength(6);
    expect(bodies[1].messages).toHaveLength(10);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 5]);
    expect(bodies[1].messages[5]).toMatchObject({
      role: "tool",
      tool_call_id: "first-b",
    });
    expect(bodies[1].messages[9]).toMatchObject({
      role: "tool",
      tool_call_id: "second-c",
      content: "result for second-c",
    });
    expect(canonicalMessages(bodies[1]).slice(0, bodies[0].messages.length)).toEqual(
      canonicalMessages(bodies[0]),
    );
  });

  for (const changed of ["history", "tools", "reasoning", "system"] as const) {
    it(`invalidates the prior boundary when ${changed} changes`, async () => {
      const { client, bodies } = capturingClient({
        model: "openai/gpt-5.6-sol",
        providerKind: "openrouter",
      });
      const request = options();
      request.tools = [
        {
          name: "Read",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ];
      request.reasoning = { mode: "effort", effort: "low" };
      await client.createMessage(request);
      appendUserTurn(request, "second question");
      if (changed === "history") request.messages[1] = { role: "user", content: "new snapshot" };
      if (changed === "tools")
        request.tools[0] = { ...request.tools[0]!, description: "Read text" };
      if (changed === "reasoning") request.reasoning = { mode: "effort", effort: "high" };
      if (changed === "system") request.systemPrompt = "changed system";
      await client.createMessage(request);
      if (changed === "reasoning") {
        expect(bodies[0].reasoning).not.toEqual(bodies[1].reasoning);
      }
      expect(markedIndexes(bodies[1])).toEqual([0, 1]);
      appendUserTurn(request, "third question");
      await client.createMessage(request);
      expect(markedIndexes(bodies[2])).toEqual([0, 1, 4]);
    });
  }

  it("keeps the prior boundary when an unsupported reasoning change leaves the wire unchanged", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    request.tools = [
      {
        name: "Read",
        description: "Read text",
        inputSchema: { type: "object" },
      },
    ];
    request.reasoning = { mode: "effort", effort: "low" };
    await client.createMessage(request);
    appendUserTurn(request, "next question");
    request.reasoning = { mode: "effort", effort: "high" };
    await client.createMessage(request);

    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 2]);
  });

  it("invalidates a moved dynamic snapshot while preserving the new stable boundary", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    appendToolBatch(request, ["already-sent"]);
    await client.createMessage(request);
    const snapshot = request.messages.splice(1, 1)[0]!;
    appendToolBatch(request, ["fresh-persisted-result"]);
    request.messages.push(snapshot);
    request.promptCache!.stablePrefixMessageCount = request.messages.length - 1;
    await client.createMessage(request);
    expect(markedIndexes(bodies[1])).toEqual([0, 5]);
    expect(bodies[1].messages[5]).toMatchObject({
      role: "tool",
      tool_call_id: "fresh-persisted-result",
    });
  });

  it("records the last eligible user instead of a trailing assistant message", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    request.messages.push({
      role: "assistant",
      content: "trailing assistant text",
    });
    await client.createMessage(request);
    request.messages.push({ role: "user", content: "next question" });
    await client.createMessage(request);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 2]);
    expect(bodies[1].messages[3].content).toBe("trailing assistant text");
  });

  it("shares successful boundaries across clients for the same session", async () => {
    const history = new PromptCacheHistory();
    const first = capturingClient({ history });
    const request = options();
    await first.client.createMessage(request);
    const resumed = capturingClient({ history });
    appendUserTurn(request, "next run");
    await resumed.client.createMessage(request);
    expect(markedIndexes(resumed.bodies[0])).toEqual([0, 1, 2]);
    expect(resumed.bodies[0].prompt_cache_key).toBe(first.bodies[0].prompt_cache_key);
  });

  for (const changed of ["scope", "model", "endpoint", "providerKind"] as const) {
    it(`isolates shared cache history when ${changed} differs`, async () => {
      const history = new PromptCacheHistory();
      const first = capturingClient({ history });
      const request = options();
      await first.client.createMessage(request);
      const other = capturingClient({
        history,
        ...(changed === "model" ? { model: "gpt-5.6-terra" } : {}),
        ...(changed === "endpoint" ? { baseUrl: "https://gateway.example/v1" } : {}),
        ...(changed === "providerKind" ? { providerKind: "openrouter" } : {}),
      });
      if (changed === "scope") request.promptCache!.scopeId = "other-session";
      appendUserTurn(request, "next question");
      await other.client.createMessage(request);
      expect(markedIndexes(other.bodies[0])).toEqual([0, 1]);
    });
  }

  it("does not reuse another call's history without a scope", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    delete request.promptCache!.scopeId;
    await client.createMessage(request);
    appendUserTurn(request, "second question");
    await client.createMessage(request);
    expect(bodies[1].prompt_cache_key).toBeUndefined();
    expect(markedIndexes(bodies[1])).toEqual([0, 1]);
  });

  for (const failure of ["api-error", "cancelled", "stream-error"] as const) {
    it(`does not advance the successful boundary after ${failure}`, async () => {
      const { client, bodies, respondWith } = capturingClient();
      const request = options();
      await client.createMessage(request);
      appendUserTurn(request, "failed question");
      const controller = new AbortController();
      request.signal = controller.signal;
      if (failure === "stream-error") {
        request.stream = true;
        request.onChunk = () => {};
        respondWith(() => ({
          async *[Symbol.asyncIterator]() {
            yield {
              choices: [{ delta: { content: "partial" } }],
              usage: completion().usage,
            };
            throw new Error("synthetic stream failure");
          },
        }));
      } else {
        respondWith(() => {
          if (failure === "cancelled") {
            controller.abort();
            throw new OpenAI.APIUserAbortError();
          }
          throw new OpenAI.APIError(
            400,
            { message: "synthetic failure" },
            "synthetic failure",
            undefined,
          );
        });
      }
      await expect(client.createMessage(request)).rejects.toThrow();
      expect(bodies).toHaveLength(2);
      respondWith(() => completion());
      request.signal = undefined;
      request.stream = false;
      appendUserTurn(request, "successful question");
      await client.createMessage(request);
      expect(markedIndexes(bodies[2])).toEqual([0, 1, 2]);
    });
  }

  it("does not advance on an empty response with no reported input usage", async () => {
    const { client, bodies, respondWith } = capturingClient();
    const request = options();
    await client.createMessage(request);
    appendUserTurn(request, "unaccounted response");
    respondWith(() => ({ ...completion(), usage: undefined }));
    await client.createMessage(request);
    respondWith(() => completion());
    appendUserTurn(request, "next question");
    await client.createMessage(request);
    expect(markedIndexes(bodies[2])).toEqual([0, 1, 2]);
  });

  it("reuses a successful streaming boundary in a later non-streaming request", async () => {
    const { client, bodies } = capturingClient();
    const request = options();
    request.stream = true;
    request.onChunk = () => {};
    appendToolBatch(request, ["stream-result"]);
    await client.createMessage(request);
    request.stream = false;
    appendToolBatch(request, ["next-result"]);
    await client.createMessage(request);
    expect(markedIndexes(bodies[1])).toEqual([0, 1, 4]);
    expect(bodies[1].messages[4]).toMatchObject({
      role: "tool",
      tool_call_id: "stream-result",
    });
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
    const { client, bodies } = capturingClient({ model: "gpt-5.5" });
    await client.createMessage(options());
    expect(bodies[0].prompt_cache_key).toMatch(/^cs:/);
    expect(bodies[0].prompt_cache_options).toBeUndefined();
    expect(explicitMarkers(bodies[0])).toEqual([]);
  });

  it("retries and stays on implicit-only compatibility mode after rejected cache fields", async () => {
    const { client, bodies, respondWith } = capturingClient({
      model: "openai/gpt-5.6-sol",
      providerKind: "openrouter",
      retryMaxAttempts: 2,
    });
    let attempts = 0;
    respondWith(() => {
      if (++attempts === 1) {
        throw new OpenAI.APIError(
          400,
          { message: "Unknown parameter: prompt_cache_options" },
          "Unknown parameter: prompt_cache_options",
          undefined,
        );
      }
      return completion();
    });
    const request = options();
    await client.createMessage(request);
    appendUserTurn(request, "next question");
    await client.createMessage(request);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    });
    for (const body of bodies.slice(1)) {
      expect(body.prompt_cache_options).toBeUndefined();
      expect(explicitMarkers(body)).toEqual([]);
      expect(body.prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    }
    expect(client.getPromptCacheConfigIdentity()).toMatchObject({
      cacheStrategy: "openai-implicit",
      disableExplicitPromptCache: true,
    });
  });

  it("can omit a rejected affinity key without disabling supported hybrid caching", async () => {
    const { client, bodies, respondWith } = capturingClient({
      retryMaxAttempts: 2,
    });
    let attempts = 0;
    respondWith(() => {
      if (++attempts === 1) {
        throw new OpenAI.APIError(
          400,
          { message: "Unknown parameter: prompt_cache_key" },
          "Unknown parameter: prompt_cache_key",
          undefined,
        );
      }
      return completion();
    });
    const request = options();
    await client.createMessage(request);
    appendUserTurn(request, "next question");
    await client.createMessage(request);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].prompt_cache_key).toMatch(/^cs:/);
    for (const body of bodies.slice(1)) {
      expect(body.prompt_cache_key).toBeUndefined();
      expect(body.prompt_cache_options).toEqual({
        mode: "implicit",
        ttl: "30m",
      });
    }
    expect(markedIndexes(bodies[2])).toEqual([0, 1, 2]);
  });
});
