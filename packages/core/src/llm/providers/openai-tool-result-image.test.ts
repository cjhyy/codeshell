import { describe, it, expect } from "bun:test";
import { OpenAIClient } from "./openai.js";
import type { CreateMessageOptions } from "../types.js";
import type { ContentBlock } from "../../types.js";

function fakeStream(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** OpenAIClient (vision model) that records the outgoing request body. */
function clientCapturing(): { client: OpenAIClient; lastBody: () => any } {
  // Must be a model whose capability resolves to supportsVision:true, else
  // buildMessages' stripVisionFromHistory elides the nested tool_result image
  // (correctly) and there's nothing left to hoist. gpt-4o has no native
  // capability rule → falls to DEFAULT (vision:false); gpt-5 does → vision:true.
  const client = new OpenAIClient({
    provider: "openai",
    model: "gpt-5",
    apiKey: "test",
  });
  let body: any;
  (client as any)._client = {
    chat: {
      completions: {
        create: async (b: any) => {
          body = b;
          return fakeStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        },
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
    stream: true,
    onChunk: () => {},
  } as unknown as CreateMessageOptions;
}

describe("OpenAIClient tool_result with image content (view_image)", () => {
  // OpenAI 的 role:"tool" 消息不允许嵌 image。view_image 的图必须从
  // tool_result.content 里拆出来,作为独立的 user image_url 消息发出。
  it("splits the image into a separate user image_url message", async () => {
    const { client, lastBody } = clientCapturing();
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
        } as unknown as ContentBlock,
      ]),
    );

    const messages = lastBody().messages;

    // (a) the role:"tool" message is still emitted, paired by tool_call_id,
    //     with a non-empty placeholder content.
    const toolMsg = messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1",
    );
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg.content).toBe("string");
    expect(toolMsg.content.length).toBeGreaterThan(0);

    // (b) a role:"user" message carries the image as an image_url part.
    const userMsg = messages.find(
      (m: any) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p: any) => p.type === "image_url"),
    );
    expect(userMsg).toBeDefined();
    const imagePart = userMsg.content.find((p: any) => p.type === "image_url");
    expect(imagePart.image_url.url).toContain("data:image/png;base64,AAAA");
  });
});
