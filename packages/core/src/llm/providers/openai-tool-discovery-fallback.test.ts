import { describe, expect, test } from "bun:test";
import type { ContentBlock, Message, ToolDefinition } from "../../types.js";
import { toolDiscoverySchemaBlock } from "../../utils/tool-schema-discovery.js";
import { OpenAIClient } from "./openai.js";

const tool: ToolDefinition = {
  name: "mcp__catalog__lookup",
  description: "查询数据🧪",
  inputSchema: {
    type: "object",
    properties: { filters: { type: "array", items: { type: "object" } } },
    required: ["filters"],
  },
};

async function capture(content: ContentBlock[], stream = false) {
  const client = new OpenAIClient({ provider: "openai", model: "gpt-5", apiKey: "test" });
  let body: any;
  (client as any)._client = {
    chat: {
      completions: {
        create: async (request: any) => {
          body = request;
          if (request.stream) {
            return (async function* () {
              yield { choices: [{ delta: {}, finish_reason: "stop" }] };
            })();
          }
          return { choices: [{ message: { content: "done" }, finish_reason: "stop" }] };
        },
      },
    },
  };
  const messages: Message[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "discovery",
          name: "ToolSearch",
          input: { query: `select:${tool.name}` },
        },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "discovery", content }] },
  ];
  const original = JSON.stringify(messages);
  await client.createMessage({
    systemPrompt: "test",
    messages,
    tools: [],
    stream,
    ...(stream ? { onChunk: () => {} } : {}),
  });
  expect(JSON.stringify(messages)).toBe(original);
  expect(body.tools).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("discoveredTool");
  expect(JSON.stringify(body)).not.toContain("tool_reference");
  return body.messages;
}

describe("OpenAI portable discovery fallback", () => {
  test.each([false, true])("keeps exact schema and hook text when streaming=%s", async (stream) => {
    const schema = toolDiscoverySchemaBlock(tool);
    const content: ContentBlock[] = [
      { type: "text", text: "health warning\n\n" },
      schema,
      { type: "text", text: "\n\nUse CallTool.\n\nhook context" },
    ];
    const messages = await capture(content, stream);
    expect(messages.find((message: any) => message.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: "discovery",
      content: `health warning\n\n${schema.text}\n\nUse CallTool.\n\nhook context`,
    });
  });

  test("invalid metadata retains its complete fallback text", async () => {
    const schema = toolDiscoverySchemaBlock(tool);
    schema.discoveredTool = { version: 99, name: "wrong", schemaDigest: null } as never;
    const messages = await capture([schema, { type: "text", text: "\n\nusage" }]);
    expect(messages.find((message: any) => message.role === "tool").content).toBe(
      `${schema.text}\n\nusage`,
    );
  });

  test("legacy text separators and image hoisting remain unchanged", async () => {
    const messages = await capture([
      { type: "text", text: "before" },
      { type: "text", text: "" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "after" },
    ]);
    expect(messages.find((message: any) => message.role === "tool").content).toBe("before\nafter");
    expect(messages.find((message: any) => message.role === "user").content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});
