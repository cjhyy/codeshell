import { describe, it, expect } from "bun:test";
import OpenAI from "openai";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";

/**
 * Regression: gpt-5.x rejects `reasoning_effort` combined with `tools` on
 * /v1/chat/completions ("Please use /v1/responses instead"). The client should
 * (1) detect that 400, (2) drop reasoning_effort, and (3) retry immediately so
 * the SAME call succeeds — not just the next one. This is what makes the manual
 * Dream consolidation (a tool-calling background call) work on gpt-5.5.
 */

function makeApiError(message: string): OpenAI.APIError {
  // OpenAI.APIError(status, error, message, headers)
  return new OpenAI.APIError(400, { message }, message, undefined);
}

/** Stub that throws the reasoning_effort 400 on the first call, then succeeds.
 *  Records each request body so we can assert the retry dropped the field. */
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

const toolCallOpts = (): CreateMessageOptions => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "consolidate" }],
  tools: [
    {
      name: "MemoryList",
      description: "list",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
  thinking: "disabled",
  stream: false,
});

describe("OpenAIClient reasoning_effort drop (gpt-5.5 + tools)", () => {
  it("retries the same call with reasoning_effort dropped after the 400", async () => {
    const { client, bodies } = clientThatRejectsReasoningOnce({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test",
      providerKind: "openai",
      maxTokens: 2048,
    });

    const resp = await client.createMessage(toolCallOpts());
    expect(resp.text).toBe("done");

    const all = bodies();
    expect(all.length).toBe(2); // initial (rejected) + retry (success)
    // First attempt carried reasoning_effort; the retry dropped it.
    expect(all[0].reasoning_effort).toBeDefined();
    expect(all[1].reasoning_effort).toBeUndefined();
    // Tools were preserved on the retry.
    expect(Array.isArray(all[1].tools)).toBe(true);
  });
});
