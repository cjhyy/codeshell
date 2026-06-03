import { describe, it, expect } from "bun:test";
import { AnthropicClient } from "./anthropic.js";
import type { CreateMessageOptions } from "../types.js";
import type { ContentBlock } from "../../types.js";
import { VISION_PLACEHOLDER } from "../strip-vision.js";

/** Capture the request body the client sends to the (stubbed) SDK. */
function clientCapturing(model = "claude-3-5-sonnet"): { client: AnthropicClient; lastBody: () => any } {
  const client = new AnthropicClient({
    provider: "anthropic",
    apiKey: "x",
    model,
  } as ConstructorParameters<typeof AnthropicClient>[0]);
  let body: any;
  (client as any)._client = {
    messages: {
      create: async (b: any) => {
        body = b;
        return {
          id: "x",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  return { client, lastBody: () => body };
}

function optsWith(content: ContentBlock[]): CreateMessageOptions {
  return {
    systemPrompt: "sys",
    messages: [{ role: "user", content }],
    tools: [],
    stream: false,
    onChunk: () => {},
  } as unknown as CreateMessageOptions;
}

describe("AnthropicClient tool_result is_error propagation", () => {
  it("sets is_error:true on the API block when the ContentBlock is flagged errored", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(
      optsWith([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "Error: Tool timed out after 300000ms: GenerateImage",
          is_error: true,
        },
      ]),
    );

    const msg = lastBody().messages.find((m: any) => m.role === "user");
    const block = (msg.content as any[]).find(
      (b) => b.type === "tool_result" && b.tool_use_id === "call_1",
    );
    expect(block).toBeDefined();
    expect(block.is_error).toBe(true);
    expect(block.content).toContain("timed out");
  });

  it("filters image blocks for non-vision anthropic-style models", async () => {
    const { client, lastBody } = clientCapturing("text-only-anthropic-model");
    const original: ContentBlock[] = [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ];

    await client.createMessage(optsWith(original));

    const msg = lastBody().messages.find((m: any) => m.role === "user");
    expect((msg.content as any[]).some((b) => b.type === "image")).toBe(false);
    expect((msg.content as any[]).some((b) => b.type === "text" && b.text === VISION_PLACEHOLDER)).toBe(true);
    expect(original.some((b) => b.type === "image")).toBe(true);
  });

  it("keeps image blocks for vision-capable Claude models", async () => {
    const { client, lastBody } = clientCapturing("claude-3-5-sonnet");
    await client.createMessage(
      optsWith([
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "abc" },
        },
      ]),
    );

    const msg = lastBody().messages.find((m: any) => m.role === "user");
    expect((msg.content as any[]).some((b) => b.type === "image")).toBe(true);
  });

  it("maps an image-bearing tool_result.content array to API image blocks (vision model)", async () => {
    const { client, lastBody } = clientCapturing("claude-3-5-sonnet");
    await client.createMessage(
      optsWith([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ]),
    );

    const msg = lastBody().messages.find((m: any) => m.role === "user");
    const block = (msg.content as any[]).find(
      (b) => b.type === "tool_result" && b.tool_use_id === "call_1",
    );
    expect(block).toBeDefined();
    expect(Array.isArray(block.content)).toBe(true);
    expect(block.content[0].type).toBe("image");
    expect(block.content[0].source.media_type).toBe("image/png");
  });

  it("omits is_error (or leaves it falsy) for a successful tool_result", async () => {
    const { client, lastBody } = clientCapturing();
    await client.createMessage(
      optsWith([
        {
          type: "tool_result",
          tool_use_id: "call_ok",
          content: "Generated image saved to /tmp/x.png",
        },
      ]),
    );

    const msg = lastBody().messages.find((m: any) => m.role === "user");
    const block = (msg.content as any[]).find(
      (b) => b.type === "tool_result" && b.tool_use_id === "call_ok",
    );
    expect(block).toBeDefined();
    expect(block.is_error).toBeFalsy();
  });
});
