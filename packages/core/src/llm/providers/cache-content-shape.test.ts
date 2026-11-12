import { describe, expect, it } from "bun:test";
import { OpenAIClient } from "./openai.js";
import { anthropicMessages } from "./anthropic-discovery-wire.js";
import { stabilizeExplicitCacheContent, usesExplicitCacheMarkers } from "./openai-cache-content.js";
import { PromptCacheHistory, resolvePromptCachePolicy } from "../prompt-cache.js";
import type { PromptCachePolicy, PromptCacheStrategy } from "../prompt-cache.js";
import type { Message } from "../../types.js";

/**
 * A provider resumes a cached prefix only when the bytes before the save point
 * are identical. A message sent as a marked text-block array in one request
 * and as a plain string in the next is NOT identical (verified on the Claude
 * route via OpenRouter: docs/todo/prompt-cache-probes-20261112/README.md), so
 * the representation of a message must not depend on whether it carries a
 * marker. Moving the marker may change the marker field and nothing else.
 */

const MARKER_FIELDS = ["cache_control", "prompt_cache_breakpoint"];

/** Deep copy without cache marker fields. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !MARKER_FIELDS.includes(key))
      .map(([key, inner]) => [key, unmarked(inner)]),
  );
}

/** Index of every message that carries a marker. */
function markedIndexes(messages: any[]): number[] {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content) &&
    message.content.some((part: any) => MARKER_FIELDS.some((field) => part[field] !== undefined))
      ? [index]
      : [],
  );
}

const history: Message[] = [
  { role: "user", content: "first task" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.ts" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }] },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second task" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/b.ts" } }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call_2", content: "other body" }],
  },
  { role: "user", content: [{ type: "text", text: "context update" }] },
];

function openAIClient(settings: { model: string; providerKind: string; baseUrl: string }) {
  const bodies: any[] = [];
  const client = new OpenAIClient(
    { provider: "openai", apiKey: "test", ...settings } as never,
    { retryMaxAttempts: 1 },
    { promptCacheHistory: new PromptCacheHistory() },
  );
  (client as any)._client = {
    chat: {
      completions: {
        create: async (body: any) => {
          bodies.push(structuredClone(body));
          return {
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
          };
        },
      },
    },
  };
  const send = async (stablePrefixMessageCount: number | undefined): Promise<any[]> => {
    await client.createMessage({
      systemPrompt: "SYSTEM",
      messages: history,
      tools: [],
      stream: false,
      ...(stablePrefixMessageCount === undefined
        ? {}
        : { promptCache: { stablePrefixMessageCount } }),
    });
    return bodies.at(-1).messages;
  };
  return { client, send };
}

const routes: Array<{
  strategy: PromptCacheStrategy;
  make: () => ReturnType<typeof openAIClient>;
}> = [
  {
    strategy: "anthropic-explicit",
    make: () =>
      openAIClient({
        model: "anthropic/claude-sonnet-4.5",
        providerKind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
  },
  {
    strategy: "openai-hybrid",
    make: () =>
      openAIClient({
        model: "gpt-5.6-sol",
        providerKind: "openai",
        baseUrl: "https://api.openai.com/v1",
      }),
  },
  {
    strategy: "openai-explicit",
    make: () => {
      const route = openAIClient({
        model: "gpt-5.6-sol",
        providerKind: "openai",
        baseUrl: "https://api.openai.com/v1",
      });
      // No route resolves to this strategy today; pin it to cover the wire.
      const policy: PromptCachePolicy = {
        strategy: "openai-explicit",
        toolDiscovery: "call-tool",
        layoutVersion: "test",
        breakpoints: ["system", "stable-history", "rolling-history"],
      };
      (route.client as any).promptCachePolicy = () => policy;
      return route;
    },
  },
];

describe("OpenAI-compatible wire content under explicit cache markers", () => {
  for (const { strategy, make } of routes) {
    it(`${strategy}: moving the marker changes only the marker field`, async () => {
      const { client, send } = make();
      if (strategy !== "openai-explicit") {
        expect(client.getPromptCacheConfigIdentity()).toMatchObject({ cacheStrategy: strategy });
      }

      // Stable marker on the first task, the first tool result, the first
      // answer (an assistant message) and the second task in turn.
      const onTask = await send(1);
      const variants = [await send(3), await send(4), await send(5)];
      const seen = [JSON.stringify(markedIndexes(onTask))];
      for (const variant of variants) {
        const marks = JSON.stringify(markedIndexes(variant));
        expect(seen).not.toContain(marks);
        seen.push(marks);
        expect(unmarked(variant)).toEqual(unmarked(onTask));
      }
      // Even a request without cache context uses the same representation.
      expect(unmarked(await send(undefined))).toEqual(unmarked(onTask));
    });

    it(`${strategy}: text content is always a text-part array`, async () => {
      const { send } = make();
      const wire = await send(1);
      expect(wire.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
        "assistant",
        "tool",
        "user",
      ]);
      for (const [index, message] of wire.entries()) {
        // The assistant turn that only calls a tool has no content at all.
        if (index === 6) expect(message.content).toBeUndefined();
        else expect(message.content).toEqual([expect.objectContaining({ type: "text" })]);
      }
      expect(wire[0].content[0].text).toBe("SYSTEM");
      expect(wire[3].content[0].text).toBe("file body");
    });
  }

  it("keeps plain strings for strategies without explicit markers", async () => {
    const { client, send } = openAIClient({
      model: "openai/gpt-5.4",
      providerKind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(client.getPromptCacheConfigIdentity()).toMatchObject({
      cacheStrategy: "openai-implicit",
    });
    const wire = await send(1);
    for (const message of wire) {
      if (message.content !== undefined) expect(typeof message.content).toBe("string");
    }
  });
});

describe("stabilizeExplicitCacheContent", () => {
  it("knows which strategies place markers", () => {
    expect(usesExplicitCacheMarkers("anthropic-explicit")).toBe(true);
    expect(usesExplicitCacheMarkers("openai-explicit")).toBe(true);
    expect(usesExplicitCacheMarkers("openai-hybrid")).toBe(true);
    expect(usesExplicitCacheMarkers("openai-implicit")).toBe(false);
    expect(usesExplicitCacheMarkers("provider-managed")).toBe(false);
  });

  it("lifts non-empty strings and leaves the rest alone", () => {
    const toolOnly = { role: "assistant" as const, tool_calls: [] };
    const parts = { role: "user" as const, content: [{ type: "text" as const, text: "parts" }] };
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "answer" },
      toolOnly,
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "tool", tool_call_id: "c2", content: "" },
      { role: "user", content: "" },
      parts,
    ];
    stabilizeExplicitCacheContent(messages, "openai-hybrid");
    expect(messages).toEqual([
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "assistant", tool_calls: [] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "result" }] },
      { role: "tool", tool_call_id: "c2", content: "" },
      { role: "user", content: "" },
      { role: "user", content: [{ type: "text", text: "parts" }] },
    ]);
    expect(messages[3]).toBe(toolOnly);
    expect(messages[7]).toBe(parts);
  });

  it("does nothing for strategies without explicit markers", () => {
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const before = structuredClone(messages);
    stabilizeExplicitCacheContent(messages, "openai-implicit");
    stabilizeExplicitCacheContent(messages, "provider-managed");
    expect(messages).toEqual(before);
  });
});

describe("Anthropic wire content under explicit cache markers", () => {
  const policy = resolvePromptCachePolicy({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });

  it("moving the marker changes only the marker field", () => {
    expect(policy.strategy).toBe("anthropic-explicit");
    expect(policy.toolDiscovery).toBe("call-tool");
    const onA = anthropicMessages(history, { stablePrefixMessageCount: 1 }, policy);
    const onB = anthropicMessages(history, { stablePrefixMessageCount: 5 }, policy);

    expect(markedIndexes(onA)).not.toEqual(markedIndexes(onB));
    expect(unmarked(onA)).toEqual(unmarked(onB));
    for (const message of onA) expect(Array.isArray(message.content)).toBe(true);
  });

  it("keeps plain strings when the route places no markers", () => {
    const managed: PromptCachePolicy = {
      strategy: "provider-managed",
      toolDiscovery: "call-tool",
      layoutVersion: "append-only-v1",
      breakpoints: [],
    };
    const wire = anthropicMessages(history, undefined, managed);
    expect(wire[0]!.content).toBe("first task");
    expect(wire[3]!.content).toBe("first answer");
  });
});
