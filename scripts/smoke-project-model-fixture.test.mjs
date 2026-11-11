import assert from "node:assert/strict";
import { test } from "node:test";
import { nextProjectFixtureResponse } from "./smoke-project-model-fixture.mjs";

function fixture(main) {
  const names = main ? ["Read", "ToolSearch", "CallTool"] : ["Read", "Write"];
  return {
    tools: names.map((name) => ({ type: "function", function: { name } })),
    messages: [{ role: "user", content: main ? "SMOKE_MAIN_RW" : "SMOKE_PANEL_RW" }],
  };
}
function complete(body, response, content) {
  body.messages.push(response.delta, {
    role: "tool",
    tool_call_id: response.delta.tool_calls[0].id,
    content,
  });
}
test("project main fixture discovers Write and uses CallTool with a frozen prefix", () => {
  const body = fixture(true);
  const prefix = JSON.stringify(body.tools);
  complete(body, nextProjectFixtureResponse(body), "written by panel process");
  const search = nextProjectFixtureResponse(body);
  assert.equal(search.stage, "select-write");
  complete(
    body,
    search,
    '### Write\nschemaRef: select:Write\n{"name":"Write","description":"write","inputSchema":{"type":"object"}}',
  );
  const write = nextProjectFixtureResponse(body);
  const call = write.delta.tool_calls[0];
  assert.equal(call.function.name, "CallTool");
  assert.equal(JSON.parse(call.function.arguments).name, "Write");
  complete(body, write, "written");
  assert.equal(nextProjectFixtureResponse(body).stage, "completed");
  assert.equal(JSON.stringify(body.tools), prefix);
});
test("project fixture rejects incomplete discovery and keeps explicit Panel tools direct", () => {
  const main = fixture(true);
  complete(main, nextProjectFixtureResponse(main), "written by panel process");
  complete(main, nextProjectFixtureResponse(main), "Selected tools for this run: Write.");
  assert.throws(() => nextProjectFixtureResponse(main), /ToolSearch did not select Write/);
  const panel = fixture(false);
  complete(panel, nextProjectFixtureResponse(panel), "written by main agent after Read");
  const write = nextProjectFixtureResponse(panel);
  assert.equal(write.delta.tool_calls[0].function.name, "Write");
  complete(panel, write, "written");
  assert.equal(nextProjectFixtureResponse(panel).stage, "completed");
});
