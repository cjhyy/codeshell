import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";
import type { Message } from "../../types.js";

/**
 * Prompt-cache breakpoints for Anthropic-family models routed through
 * OpenRouter's OpenAI-compatible endpoint.
 *
 * Anthropic caching is EXPLICIT: the request must carry `cache_control`
 * breakpoints or nothing is cached (verified live 2026-07-02 against
 * anthropic/claude-opus-4.7-fast via OpenRouter — plain string system →
 * cached_tokens 0 on every repeat; a system-block breakpoint → the whole
 * stable prefix, including tool definitions, becomes a cache hit on the
 * second call, cutting cost ~89%).
 *
 * OpenRouter accepts the OpenAI multimodal content-array wire form
 * (`content: [{type:"text", text, cache_control:{type:"ephemeral"}}]`), so
 * these breakpoints ride the normal /chat/completions body.
 *
 * Placement (mirrors the native anthropic provider, ≤4 breakpoints):
 *   1. System block  → caches the stable prefix (tools + system prompt).
 *   2. Last message  → one rolling breakpoint so growing history is cached.
 *
 * This ONLY fires for providerKind "openrouter" + an anthropic/* model slug.
 * Plain OpenAI (and non-Anthropic OpenRouter models) cache automatically and
 * must NOT get breakpoints.
 */

function capturingClient(cfg: { providerKind: string; model: string }): {
  client: OpenAIClient;
  lastBody: () => any;
} {
  const client = new OpenAIClient({
    provider: "openai",
    model: cfg.model,
    apiKey: "test",
    providerKind: cfg.providerKind as any,
    baseUrl: "https://openrouter.ai/api/v1",
    maxTokens: 2048,
  });
  let body: any;
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          body = b;
          return {
            id: "x",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          };
        },
      },
    },
  };
  return { client, lastBody: () => body };
}

const opts = (
  messages: Message[],
  tools?: CreateMessageOptions["tools"],
): CreateMessageOptions => ({
  systemPrompt: "SYSTEM PREFIX",
  messages,
  tools: tools ?? [],
  stream: false,
});

describe("OpenAIClient OpenRouter+Anthropic prompt-cache breakpoints", () => {
  it("identifies explicit versus automatic provider cache strategies", () => {
    const anthropic = capturingClient({
      providerKind: "openrouter",
      model: "anthropic/claude-opus-4.7-fast",
    }).client;
    const ordinary = capturingClient({
      providerKind: "openrouter",
      model: "openai/gpt-5.4",
    }).client;

    expect(anthropic.getPromptCacheConfigIdentity()).toMatchObject({
      cacheStrategy: "openrouter-anthropic-explicit",
      cacheLayoutVersion: "system-history-v1",
    });
    expect(ordinary.getPromptCacheConfigIdentity()).toMatchObject({
      cacheStrategy: "provider-automatic",
      cacheLayoutVersion: "automatic-v1",
    });
  });

  it("marks the system message as a content-array text block with cache_control", async () => {
    const { client, lastBody } = capturingClient({
      providerKind: "openrouter",
      model: "anthropic/claude-opus-4.7-fast",
    });
    await client.createMessage(opts([{ role: "user", content: "hi" }]));
    const sys = lastBody().messages[0];
    expect(sys.role).toBe("system");
    expect(Array.isArray(sys.content)).toBe(true);
    const block = sys.content[0];
    expect(block.type).toBe("text");
    expect(block.text).toBe("SYSTEM PREFIX");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the last content block of the last message (rolling history breakpoint)", async () => {
    const { client, lastBody } = capturingClient({
      providerKind: "openrouter",
      model: "anthropic/claude-opus-4.7-fast",
    });
    await client.createMessage(
      opts([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]),
    );
    const sent = lastBody().messages;
    const last = sent[sent.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.text).toBe("second");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("also fires for the ~anthropic/ router-alias slug", async () => {
    const { client, lastBody } = capturingClient({
      providerKind: "openrouter",
      model: "~anthropic/claude-opus-latest",
    });
    await client.createMessage(opts([{ role: "user", content: "hi" }]));
    const sys = lastBody().messages[0];
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT add breakpoints for plain OpenAI (automatic caching)", async () => {
    const { client, lastBody } = capturingClient({
      providerKind: "openai",
      model: "gpt-5.5",
    });
    await client.createMessage(opts([{ role: "user", content: "hi" }]));
    const sys = lastBody().messages[0];
    // Plain OpenAI keeps the system prompt a bare string, no breakpoints.
    expect(sys.content).toBe("SYSTEM PREFIX");
    const last = lastBody().messages[lastBody().messages.length - 1];
    // User message stays a plain string too.
    expect(last.content).toBe("hi");
  });

  it("marks a tool-result turn (emitted as role:tool) when it is the last message", async () => {
    // In this codebase tool_result blocks ride inside a role:"user" Message;
    // buildMessages splits them into a standalone role:"tool" message. When
    // that tool message is the tail, the rolling breakpoint lifts its string
    // content to a cache_control-carrying text array. OpenRouter accepts a
    // content-array with cache_control on a role:"tool" message (verified live
    // 2026-07-02).
    const { client, lastBody } = capturingClient({
      providerKind: "openrouter",
      model: "anthropic/claude-opus-4.7-fast",
    });
    await client.createMessage(
      opts([
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
        },
      ]),
    );
    const sent = lastBody().messages;
    const last = sent[sent.length - 1];
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("t1");
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.text).toBe("output");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT add breakpoints for a non-Anthropic OpenRouter model", async () => {
    const { client, lastBody } = capturingClient({
      providerKind: "openrouter",
      model: "openai/gpt-4o-mini",
    });
    await client.createMessage(opts([{ role: "user", content: "hi" }]));
    const sys = lastBody().messages[0];
    expect(sys.content).toBe("SYSTEM PREFIX");
  });
});
