import { describe, it, expect } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * gpt-5.x rejects `reasoning_effort` combined with `tools` on
 * /v1/chat/completions ("Please use /v1/responses instead").
 *
 * Two layers defend against this:
 *  - PROACTIVE (preferred): the gpt-5.5+ capability carries
 *    `noEffortWithTools: true`, so the client omits `reasoning_effort` on ANY
 *    tool-bearing request up-front — no 400, no retry, one successful call.
 *  - REACTIVE (safety net for untagged variants): if a 400 DOES come back, the
 *    client flips a sticky `_dropReasoningEffort` and retries the same call.
 */

function makeApiError(message: string): InstanceType<typeof OpenAI.APIError> {
  // OpenAI.APIError(status, error, message, headers)
  return new OpenAI.APIError(400, { message }, message, undefined);
}

/** Stub that records each request body and always succeeds. */
function clientThatSucceeds(
  config: ConstructorParameters<typeof OpenAIClient>[0],
): { client: OpenAIClient; bodies: () => any[] } {
  const bodies: any[] = [];
  const client = new OpenAIClient(config);
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          bodies.push(b);
          return {
            id: "x",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  return { client, bodies: () => bodies };
}

/** Stub that throws the reasoning_effort 400 on the first call, then succeeds. */
function clientThatRejectsReasoningOnce(
  config: ConstructorParameters<typeof OpenAIClient>[0],
): { client: OpenAIClient; bodies: () => any[] } {
  const bodies: any[] = [];
  const client = new OpenAIClient(config);
  let calls = 0;
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          bodies.push(b);
          calls += 1;
          if (calls === 1) {
            throw makeApiError(
              "Function tools with reasoning_effort are not supported for gpt-5.5 in /v1/chat/completions. Please use /v1/responses instead.",
            );
          }
          return {
            id: "x",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  return { client, bodies: () => bodies };
}

const toolCallOpts = (reasoning: CreateMessageOptions["reasoning"]): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "consolidate" }],
  tools: [
    {
      name: "MemoryList",
      description: "list",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
  reasoning,
  stream: false,
});

describe("OpenAIClient reasoning_effort + tools (gpt-5.5)", () => {
  it("proactively omits reasoning_effort on tool turns — one call, no 400 (effort on)", async () => {
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
    });

    const resp = await client.createMessage(toolCallOpts({ mode: "effort", effort: "high" }));
    expect(resp.text).toBe("done");

    const all = bodies();
    // Single successful call — the proactive suppression means no rejected
    // first attempt + retry (the old behavior burned a 400 + 1s backoff/turn).
    expect(all.length).toBe(1);
    expect(all[0].reasoning_effort).toBeUndefined();
    expect(Array.isArray(all[0].tools)).toBe(true);
  });

  it("proactively omits reasoning_effort on tool turns even when reasoning is off", async () => {
    const { client, bodies } = clientThatSucceeds({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
    });

    await client.createMessage(toolCallOpts({ mode: "off" }));
    const all = bodies();
    expect(all.length).toBe(1);
    // The "off" branch would normally send reasoning_effort: "none"; suppressed
    // because tools are present on a noEffortWithTools model.
    expect(all[0].reasoning_effort).toBeUndefined();
  });

  it("still STICKY-drops reactively if a 400 ever slips through", async () => {
    // gpt-5.4 matches the broader gpt-5 rule, which is NOT tagged with
    // `noEffortWithTools` — so the FIRST attempt carries reasoning_effort and
    // 400s, exercising the reactive sticky fallback (no shared-RULES mutation).
    const { client, bodies } = clientThatRejectsReasoningOnce({
      provider: "openai",
      model: "gpt-5.4",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
    });

    const resp = await client.createMessage(toolCallOpts({ mode: "effort", effort: "high" }));
    expect(resp.text).toBe("done");

    const all = bodies();
    expect(all.length).toBe(2); // initial (rejected) + retry (success)
    expect(all[0].reasoning_effort).toBeDefined();
    expect(all[1].reasoning_effort).toBeUndefined();
    expect(Array.isArray(all[1].tools)).toBe(true);
  });
});
