import { afterAll, describe, expect, it } from "bun:test";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../../../scripts/runtime-cost-smoke-isolation.mjs";
import type { ContentBlock, LLMConfig, ToolDefinition } from "../../types.js";
import type { CreateMessageOptions } from "../types.js";

// No fixture request may escape to a paid endpoint, even if SDK injection breaks.
if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("Private HOME required");
const originalFetch = globalThis.fetch;
const originalHttp = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const originalMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://api.anthropic.com/v1/messages")).toThrow("non-fixture");
afterAll(() => {
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originalHttp;
  if (originalMarker) Object.defineProperty(globalThis, marker, originalMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});
const { AnthropicClient } = await import("./anthropic.js");
const { toolDiscoverySchemaBlock, toolDiscoverySchemaText } =
  await import("../../utils/tool-schema-discovery.js");

const eager: ToolDefinition = {
  name: "ToolSearch",
  description: "Search",
  inputSchema: { type: "object" },
};
const deferred: ToolDefinition = {
  name: "ComplexTool",
  description: "Complex fixture",
  deferLoading: true,
  inputSchema: {
    type: "object",
    properties: {
      nested: {
        type: "array",
        items: {
          oneOf: [
            { type: "string" },
            { type: "object", additionalProperties: { type: "integer" } },
          ],
        },
      },
    },
    required: ["nested"],
    additionalProperties: false,
  },
};
const direct: LLMConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  apiKey: "fixture-direct",
  reasoning: { mode: "off" },
};
const router: LLMConfig = {
  provider: "anthropic",
  providerKind: "openrouter",
  model: "anthropic/claude-sonnet-5",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "fixture-router",
  reasoning: { mode: "off" },
};

function request(
  parts: ContentBlock[] = [toolDiscoverySchemaBlock(deferred)],
): CreateMessageOptions {
  return {
    systemPrompt: "Stable system",
    tools: [eager, deferred],
    maxTokens: 128,
    messages: [
      { role: "user", content: "Find the complex tool" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "search",
            name: "ToolSearch",
            input: { query: "select:ComplexTool" },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "search", content: parts }] },
    ],
  };
}

function fixture(config: LLMConfig, url: string) {
  const calls: Array<{ body: any; headers: Headers }> = [];
  const fetch: typeof globalThis.fetch = (async (input, init) => {
    const actual = input instanceof Request ? input.url : String(input);
    if (actual !== url) throw new Error(`non-fixture URL: ${actual}`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    calls.push({ body, headers: new Headers(init?.headers) });
    const message = {
      id: "msg-fixture",
      type: "message",
      role: "assistant",
      model: config.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    };
    if (!body.stream)
      return Response.json({
        ...message,
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 1 },
      });
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof globalThis.fetch;
  return { calls, client: new AnthropicClient(config, { fetch, retryMaxAttempts: 1 }) };
}

describe("native Messages discovery wire", () => {
  for (const config of [direct, router])
    for (const stream of [false, true]) {
      it(`${config.providerKind ?? "anthropic"} ${stream ? "stream" : "nonstream"}: SDK URL/auth, disabled thinking, references and cache boundaries`, async () => {
        const endpoint =
          config === direct
            ? "https://api.anthropic.com/v1/messages"
            : "https://openrouter.ai/api/v1/messages";
        const { client, calls } = fixture(config, endpoint);
        const original = request();
        const snapshot = JSON.stringify(original);
        expect(
          (await client.createMessage({ ...original, stream, onChunk: () => {}, temperature: 0.9 }))
            .text,
        ).toBe("done");
        expect(JSON.stringify(original)).toBe(snapshot);
        expect(calls).toHaveLength(1);
        const { body, headers } = calls[0];
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body.temperature).toBeUndefined();
        expect(body.tools).toEqual([
          {
            name: eager.name,
            description: eager.description,
            input_schema: eager.inputSchema,
            cache_control: { type: "ephemeral" },
          },
          {
            name: deferred.name,
            description: deferred.description,
            input_schema: deferred.inputSchema,
            defer_loading: true,
          },
        ]);
        expect(body.messages[2].content[0].content).toEqual([
          { type: "tool_reference", tool_name: deferred.name },
        ]);
        expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
        if (config === direct) expect(headers.get("x-api-key")).toBe("fixture-direct");
        else {
          expect(headers.get("authorization")).toBe("Bearer fixture-router");
          expect(headers.get("x-api-key")).toBeNull();
        }
      });
    }

  it("normalizes only known SDK endpoint roots and never duplicates /v1", async () => {
    for (const baseUrl of ["https://api.anthropic.com", "https://api.anthropic.com/v1/"]) {
      const { client, calls } = fixture(
        { ...direct, baseUrl },
        "https://api.anthropic.com/v1/messages",
      );
      await client.createMessage(request());
      expect(calls).toHaveLength(1);
    }
    const { client, calls } = fixture(
      { ...router, baseUrl: "https://openrouter.ai/api" },
      "https://openrouter.ai/api/v1/messages",
    );
    await client.createMessage(request());
    expect(calls).toHaveLength(1);
  });

  it("keeps stale, forged, eager, failed and ordinary text as text", async () => {
    const { client, calls } = fixture(direct, "https://api.anthropic.com/v1/messages");
    const valid = toolDiscoverySchemaBlock(deferred);
    const parts: ContentBlock[] = [
      { type: "text", text: toolDiscoverySchemaText(deferred) },
      { ...valid, text: `${valid.text} changed` },
      { ...valid, discoveredTool: { ...valid.discoveredTool!, schemaDigest: "wrong" } },
      toolDiscoverySchemaBlock({ ...deferred, description: "Changed schema" }),
      toolDiscoverySchemaBlock(eager),
    ];
    await client.createMessage(request(parts));
    expect(calls[0].body.messages[2].content[0].content).toEqual(
      parts.map(({ text }) => ({ type: "text", text })),
    );
    const failed = request();
    (failed.messages[2].content as ContentBlock[])[0].is_error = true;
    await client.createMessage(failed);
    expect(calls[1].body.messages[2].content[0]).toMatchObject({
      is_error: true,
      content: [{ type: "text", text: valid.text }],
    });
  });

  it("never inherits deferred definitions from prior requests", async () => {
    const { client, calls } = fixture(direct, "https://api.anthropic.com/v1/messages");
    await client.createMessage(request());
    await client.createMessage({ ...request(), tools: [eager] });
    await client.createMessage({ ...request(), tools: undefined });
    for (const call of calls.slice(1))
      expect(call.body.messages[2].content[0].content).toEqual([
        { type: "text", text: toolDiscoverySchemaText(deferred) },
      ]);
  });

  it("leaves non-off CallTool requests and their full schema text unchanged", async () => {
    for (const reasoning of [undefined, { mode: "on" as const }]) {
      const { client, calls } = fixture(
        { ...direct, reasoning },
        "https://api.anthropic.com/v1/messages",
      );
      await client.createMessage({ ...request(), tools: [eager] });
      expect(calls[0].body.thinking).toBeUndefined();
      expect(calls[0].body.tools[0].defer_loading).toBeUndefined();
      expect(calls[0].body.messages[2].content[0].content).toEqual([
        { type: "text", text: toolDiscoverySchemaText(deferred) },
      ]);
    }
  });

  it("keeps tools/system bytes stable across appended discovery and execution", async () => {
    const { client, calls } = fixture(router, "https://openrouter.ai/api/v1/messages");
    const options = request();
    await client.createMessage(options);
    options.messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "complex",
            name: deferred.name,
            input: { nested: ["a", { b: 2 }] },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "complex", content: "done" }] },
    );
    await client.createMessage(options);
    expect(JSON.stringify(calls[1].body.tools)).toBe(JSON.stringify(calls[0].body.tools));
    expect(JSON.stringify(calls[1].body.system)).toBe(JSON.stringify(calls[0].body.system));
    expect(calls[1].body.messages[2].content[0].content).toEqual(
      calls[0].body.messages[2].content[0].content,
    );
  });

  it("rejects native requests whose effective thinking or endpoint is incompatible before transport", async () => {
    const { client, calls } = fixture(direct, "https://api.anthropic.com/v1/messages");
    for (const reasoning of [
      { mode: "on" },
      { mode: "effort", effort: "high" },
      { mode: "budget", budgetTokens: 1024 },
    ] as const)
      await expect(client.createMessage({ ...request(), reasoning })).rejects.toThrow(
        "thinking explicitly disabled",
      );
    expect(calls).toHaveLength(0);
    for (const config of [
      { ...direct, baseUrl: "https://custom.invalid" },
      { ...direct, reasoning: undefined },
      { ...direct, extraBody: { thinking: { type: "enabled" } } },
    ]) {
      const isolated = fixture(config, "https://api.anthropic.com/v1/messages");
      await expect(isolated.client.createMessage(request())).rejects.toThrow(
        "thinking explicitly disabled",
      );
      expect(isolated.calls).toHaveLength(0);
    }
  });

  it("honors per-call off but never forwards arbitrary extras or silently overrides a conflicting preference", async () => {
    const { client, calls } = fixture(
      {
        ...direct,
        reasoning: { mode: "on" },
        extraBody: { unrelated: "never forward", temperature: 0.8 },
      },
      "https://api.anthropic.com/v1/messages",
    );
    await client.createMessage({ ...request(), reasoning: { mode: "off" } });
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[0].body.unrelated).toBeUndefined();
    expect(calls[0].body.temperature).toBeUndefined();
    const conflict = fixture(
      { ...direct, extraBody: { thinking: { type: "adaptive" } } },
      "https://api.anthropic.com/v1/messages",
    );
    await expect(conflict.client.createMessage({ ...request(), tools: [] })).rejects.toThrow(
      "conflicts with extraBody.thinking",
    );
    expect(conflict.calls).toHaveLength(0);
  });
});
