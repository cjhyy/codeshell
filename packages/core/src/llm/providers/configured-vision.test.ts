import { describe, expect, test } from "bun:test";
import { OpenAIClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import type { LLMConfig, Message } from "../../types.js";

const messages: Message[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ],
  },
];

describe("provider requests honor configured model capabilities", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    test.each([
      ["future-vision", true, true],
      [provider === "openai" ? "openai/gpt-5.6-sol" : "claude-sonnet-4-6", false, false],
      ["future-unknown", undefined, false],
    ] as const)(
      `${provider} %s configured=%s sends images=%s`,
      async (model, supportsVision, allowed) => {
        let body: any;
        const config: LLMConfig = {
          provider,
          providerKind: provider === "openai" ? "openrouter" : "anthropic",
          model,
          supportsVision,
          baseUrl: "http://configured-vision.invalid/v1",
          apiKey: "fixture-only",
        };
        const defaults = {
          fetch: async (input: any, init: any) => {
            const request = new Request(input, init);
            expect(new URL(request.url).origin).toBe("http://configured-vision.invalid");
            body = await request.json();
            const response =
              provider === "openai"
                ? {
                    choices: [
                      { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
                    ],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                  }
                : {
                    id: "fixture",
                    type: "message",
                    role: "assistant",
                    model,
                    content: [{ type: "text", text: "ok" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 1, output_tokens: 1 },
                  };
            return Response.json(response);
          },
        };
        const client =
          provider === "openai"
            ? new OpenAIClient(config, defaults)
            : new AnthropicClient(config, defaults);
        expect((await client.createMessage({ systemPrompt: "fixture", messages })).text).toBe("ok");
        expect(body.model).toBe(model);
        expect(
          JSON.stringify(body.messages).includes(
            provider === "openai" ? "image_url" : '"type":"image"',
          ),
        ).toBe(allowed);
        // Request filtering must not mutate the saved history when switching models.
        expect(messages[0].content).toHaveLength(2);
      },
    );
  }
});
