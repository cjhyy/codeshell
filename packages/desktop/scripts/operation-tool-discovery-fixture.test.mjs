import { expect, test } from "bun:test";
import { discoveredFixtureCall } from "./operation-tool-discovery-fixture.mjs";
import { batchWorkerItems, startBatchWorkerWire } from "./operation-batch-worker-fixture.mjs";

const toolNames = Object.freeze(["ToolSearch", "CallTool"]);
const call = Object.freeze({
  id: "write",
  toolName: "LinkAction",
  args: { provider: "github", action: "create_issue", params: batchWorkerItems[0] },
});
const content =
  "### LinkAction\nschemaRef: select:LinkAction\n" +
  JSON.stringify({
    name: "LinkAction",
    description: "Fixture action",
    inputSchema: { type: "object" },
  });
const discovery = { content };

test("native SDK fixtures discover once then dispatch with the same frozen tools and call id", () => {
  expect(discoveredFixtureCall(toolNames, undefined, call, "discover")).toEqual({
    id: "discover",
    toolName: "ToolSearch",
    args: { query: "select:LinkAction" },
  });
  expect(discoveredFixtureCall(toolNames, discovery, call, "discover")).toEqual({
    id: "write",
    toolName: "CallTool",
    args: { name: "LinkAction", args: call.args },
  });
  expect(toolNames).toEqual(["ToolSearch", "CallTool"]);
  expect(discoveredFixtureCall(["LinkAction"], undefined, call, "discover")).toBe(call);
});

for (const [label, names, result] of [
  ["missing search", [], undefined],
  ["failed selection", toolNames, { content, is_error: true }],
  [
    "metadata without a schema",
    toolNames,
    { content: "### LinkAction\nschemaRef: select:LinkAction" },
  ],
  ["missing input schema", toolNames, { content: '{"name":"LinkAction","description":"x"}' }],
  ["missing dispatcher", ["ToolSearch"], discovery],
  ["truncated schema", toolNames, { content: '{"name":"LinkAction","inputSchema":' }],
]) {
  test(`fixture rejects ${label} instead of repeating discovery`, () => {
    expect(() => discoveredFixtureCall(names, result, call, "discover")).toThrow();
  });
}

test("actual batch HTTP producer consumes discovery history and completes with frozen tools", async () => {
  const wire = await startBatchWorkerWire("success", { ledgerPath: "unused-for-model-only-test" });
  try {
    const tools = toolNames.map((name) => ({ type: "function", function: { name } }));
    const messages = [];
    const next = async () => {
      const response = await fetch(`${wire.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture", tools, messages }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).choices[0].message;
    };
    expect((await next()).tool_calls[0].function).toEqual({
      name: "ToolSearch",
      arguments: JSON.stringify({ query: "select:LinkAction" }),
    });
    messages.push({ role: "tool", tool_call_id: "batch-search", content });
    for (const [index, item] of batchWorkerItems.entries()) {
      const result = await next();
      const dispatched = result.tool_calls[0];
      expect(dispatched.id).toBe(`batch-item-${index + 1}`);
      expect(dispatched.function.name).toBe("CallTool");
      const args = JSON.parse(dispatched.function.arguments);
      expect(args.name).toBe("LinkAction");
      expect(args.args.params).toEqual(item);
      messages.push({ role: "tool", tool_call_id: dispatched.id, content: "fixture result" });
    }
    expect((await next()).tool_calls).toBeUndefined();
    const snapshot = wire.snapshot();
    expect(snapshot.mainModelCount).toBe(4);
    expect(snapshot.linkStep).toBe(2);
    expect(snapshot.unexpected).toBe(0);
    expect(
      snapshot.requests.every(
        (request) => JSON.stringify(request.toolNames) === JSON.stringify(toolNames),
      ),
    ).toBe(true);
  } finally {
    await wire.close();
  }
});
