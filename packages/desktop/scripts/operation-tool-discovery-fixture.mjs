import assert from "node:assert/strict";

/** Produce a model call from the schema returned in history, without expecting
 * discovery to change the frozen top-level tools. No execution is mocked here. */
export function discoveredFixtureCall(toolNames, discoveryResult, call, discoveryId) {
  if (toolNames.includes(call.toolName)) return call;
  if (!discoveryResult) {
    assert.ok(toolNames.includes("ToolSearch"), "Missing fixture tool-discovery path");
    return {
      id: discoveryId,
      toolName: "ToolSearch",
      args: { query: `select:${call.toolName}` },
    };
  }
  assert.ok(!discoveryResult.is_error, "Fixture tool discovery failed");
  assert.equal(typeof discoveryResult.content, "string");
  const schemaLine = discoveryResult.content
    .split("\n")
    .find((line) => line.startsWith(`{"name":${JSON.stringify(call.toolName)},`));
  assert.ok(schemaLine, "Fixture tool discovery did not return the complete schema");
  const definition = JSON.parse(schemaLine);
  assert.equal(definition.inputSchema?.type, "object");
  assert.ok(toolNames.includes("CallTool"), "Missing deferred-tool dispatcher");
  return {
    id: call.id,
    toolName: "CallTool",
    args: { name: call.toolName, args: call.args },
  };
}
