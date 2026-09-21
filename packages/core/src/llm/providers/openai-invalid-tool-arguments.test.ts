import { describe, expect, test } from "bun:test";
import { OpenAIClient } from "./openai.js";
import { HookRegistry } from "../../hooks/registry.js";
import { PermissionClassifier } from "../../tool-system/permission.js";
import { ToolRegistry } from "../../tool-system/registry.js";
import { ToolExecutor } from "../../tool-system/executor.js";

describe("OpenAI malformed tool arguments", () => {
  for (const stream of [false, true]) {
    test.each(['{"workspaceId":', "null", "[]", '"text"'])(
      `rejects %s before execution (stream=${stream}) and permits a repaired call`,
      async (argumentsText) => {
        let executed = 0;
        const registry = new ToolRegistry({ builtinTools: [] });
        registry.registerTool(
          {
            name: "OptionalTool",
            description: "test",
            source: "builtin",
            inputSchema: { type: "object", properties: {} },
            permissionDefault: "allow",
            pathPolicyExempt: true,
          },
          async () => {
            executed++;
            return { result: "ok" };
          },
        );
        const executor = new ToolExecutor(
          registry,
          new PermissionClassifier([], "bypassPermissions"),
          new HookRegistry(),
        );
        const client = new OpenAIClient({ provider: "openai", model: "gpt-4o", apiKey: "test" });
        (client as any)._client = {
          chat: {
            completions: {
              create: async () => {
                const tool = {
                  id: "call-1",
                  type: "function",
                  function: { name: "OptionalTool", arguments: argumentsText },
                };
                return stream
                  ? {
                      async *[Symbol.asyncIterator]() {
                        yield { choices: [{ delta: { tool_calls: [{ ...tool, index: 0 }] } }] };
                        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
                      },
                    }
                  : {
                      choices: [
                        {
                          message: { content: "", tool_calls: [tool] },
                          finish_reason: "tool_calls",
                        },
                      ],
                    };
              },
            },
          },
        };
        const response = await client.createMessage({
          systemPrompt: "test",
          messages: [{ role: "user", content: "test" }],
          tools: [],
          stream,
          onChunk: () => {},
        });
        expect(response.toolCalls).toHaveLength(1);
        const rejected = await executor.executeSingle(response.toolCalls[0]!);
        expect(rejected.isError).toBe(true);
        expect(rejected.error).toContain("complete JSON object");
        expect(rejected.error).not.toContain("Missing required");
        expect(executed).toBe(0);
        expect(
          await executor.executeSingle({ id: "repaired", toolName: "OptionalTool", args: {} }),
        ).toMatchObject({ result: "ok" });
        expect(executed).toBe(1);
      },
    );
  }
});
