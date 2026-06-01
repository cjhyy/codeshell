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

/** OpenAIClient that records the outgoing request body. */
function clientCapturing(): { client: OpenAIClient; lastBody: () => any } {
  const client = new OpenAIClient({
    provider: "openai",
    model: "gpt-4o",
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

describe("OpenAIClient errored tool_result", () => {
  // OpenAI 的 chat API 在 tool 消息上没有 is_error 字段 —— 错误必须保留在
  // content 文字里,模型才不会把超时读成成功。
  it("carries the error text in the tool message content", async () => {
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

    const toolMsg = lastBody().messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1",
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain("Error:");
    expect(toolMsg.content).toContain("timed out");
  });
});
