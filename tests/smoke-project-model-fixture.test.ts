import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { nextProjectFixtureResponse } from "../scripts/smoke-project-model-fixture.mjs";

const tool = (name) => ({ type: "function", function: { name, parameters: {} } });
const selection = "Selected tools for this run: Write.\nschemaRef: select:Write";
function request(marker = "SMOKE_MAIN_RW", names = ["ToolSearch", "Read"]) {
  return {
    messages: [{ role: "user", content: `${marker}: read and update the shared proof file.` }],
    tools: names.map(tool),
  };
}
function complete(body, response, content) {
  const call = response.delta.tool_calls[0];
  body.messages.push(response.delta, { role: "tool", tool_call_id: call.id, content });
}
const call = (response) => response.delta.tool_calls[0].function;
const argumentsOf = (response) => JSON.parse(call(response).arguments);
function afterMainRead() {
  const body = request();
  complete(body, nextProjectFixtureResponse(body), "written by panel process\n");
  return body;
}
function afterSelection(content = selection) {
  const body = afterMainRead();
  complete(body, nextProjectFixtureResponse(body), content);
  body.tools.push(tool("Write"));
  return body;
}

test("default main Run reads, explicitly selects Write, then writes on a later model request", () => {
  const body = request();
  const read = nextProjectFixtureResponse(body);
  expect(read.stage).toBe("read");
  expect(call(read).name).toBe("Read");
  expect(argumentsOf(read)).toEqual({ file_path: "/workspace/downloads/shared-proof.txt" });
  expect(read.finishReason).toBe("tool_calls");
  complete(body, read, "written by panel process\n");

  const search = nextProjectFixtureResponse(body);
  expect(search.stage).toBe("select-write");
  expect(call(search).name).toBe("ToolSearch");
  expect(argumentsOf(search)).toEqual({ query: "select:Write" });
  complete(body, search, selection);
  body.tools.push(tool("Write")); // The real Engine refreshes only the next model step.

  const write = nextProjectFixtureResponse(body);
  expect(write.stage).toBe("write");
  expect(call(write).name).toBe("Write");
  expect(argumentsOf(write)).toEqual({
    file_path: "/workspace/downloads/shared-proof.txt",
    content: "written by main agent after Read\n",
  });
  complete(body, write, "Successfully wrote file");
  expect(nextProjectFixtureResponse(body)).toEqual({
    stage: "completed",
    delta: { role: "assistant", content: "Shared file Read and Write completed." },
    finishReason: "stop",
  });
});

test("explicit Panel Read/Write allowlist stays direct and preserves its prior-writer proof", () => {
  const body = request("SMOKE_PANEL_RW", ["Read", "Write"]);
  complete(body, nextProjectFixtureResponse(body), "written by main agent after Read\n");
  const write = nextProjectFixtureResponse(body);
  expect(call(write).name).toBe("Write");
  expect(argumentsOf(write).content).toBe("written by independent panel task after Read\n");
  complete(body, write, "Successfully wrote file");
  expect(nextProjectFixtureResponse(body).stage).toBe("completed");
});

test("a successful selection without the next advertised Write schema fails closed", () => {
  const body = afterSelection();
  body.tools = body.tools.filter((value) => value.function.name !== "Write");
  expect(() => nextProjectFixtureResponse(body)).toThrow("schema was not advertised");
});

test.each([
  ["unavailable", 'Tool "Write" is not available in the current Session context.'],
  ["no match", "No tools matching Write."],
  ["wrong tool", "Selected tools for this run: Read.\nschemaRef: select:Read"],
  ["missing schema receipt", "Selected tools for this run: Write."],
  ["private content", `private fixture token must not be echoed: ${"s".repeat(50)}`],
])(
  "failed discovery is rejected even if a later request advertises Write: %s",
  (_label, result) => {
    expect(() => nextProjectFixtureResponse(afterSelection(result))).toThrow(
      "ToolSearch did not select Write",
    );
  },
);

test("unselected Write never shortcuts the default main preset", () => {
  for (const body of [request(), afterMainRead()]) {
    body.tools.push(tool("Write"));
    expect(() => nextProjectFixtureResponse(body)).toThrow("before explicit discovery");
  }
});

test("discovery and Read schemas must be present when their real steps are requested", () => {
  for (const body of [request("SMOKE_MAIN_RW", []), request("SMOKE_MAIN_RW", ["Read"])])
    expect(() => nextProjectFixtureResponse(body)).toThrow();
  const missingRead = request("SMOKE_MAIN_RW", ["ToolSearch"]);
  expect(() => nextProjectFixtureResponse(missingRead)).toThrow("schema was not advertised");
});

test("tool result identity and step order cannot be replaced by a result count", () => {
  const unrelated = afterMainRead();
  unrelated.messages.push({ role: "tool", tool_call_id: "unrelated", content: selection });
  expect(() => nextProjectFixtureResponse(unrelated)).toThrow("unexpected tool result sequence");
  const skipped = afterMainRead();
  skipped.messages.push(
    {
      role: "assistant",
      tool_calls: [{ id: "write", function: { name: "Write" } }],
    },
    { role: "tool", tool_call_id: "write", content: "wrote" },
  );
  expect(() => nextProjectFixtureResponse(skipped)).toThrow("unexpected tool result sequence");
  const sameStep = afterMainRead();
  sameStep.messages.push(
    {
      role: "assistant",
      tool_calls: [
        { id: "select", function: { name: "ToolSearch" } },
        { id: "write", function: { name: "Write" } },
      ],
    },
    { role: "tool", tool_call_id: "select", content: selection },
    { role: "tool", tool_call_id: "write", content: "wrote" },
  );
  expect(() => nextProjectFixtureResponse(sameStep)).toThrow("separate model steps");
});

test("incorrect Read proof fails for both Run and Panel task without echoing private content", () => {
  for (const marker of ["SMOKE_MAIN_RW", "SMOKE_PANEL_RW"]) {
    const body = request(marker, marker === "SMOKE_PANEL_RW" ? ["Read", "Write"] : undefined);
    complete(body, nextProjectFixtureResponse(body), "fixture-private-Read-error");
    let failure;
    try {
      nextProjectFixtureResponse(body);
    } catch (error) {
      failure = error;
    }
    expect(failure.message).toContain("prior writer proof");
    expect(failure.message).not.toContain("fixture-private");
  }
});

test("serialization into the container model keeps the real discovery sequence without imports", () => {
  const serialized = runInNewContext(`(${nextProjectFixtureResponse.toString()})`, {});
  const body = afterMainRead();
  const before = JSON.stringify(body);
  expect(JSON.parse(JSON.stringify(serialized(body)))).toEqual(nextProjectFixtureResponse(body));
  expect(JSON.stringify(body)).toBe(before);
  const selected = afterSelection();
  expect(serialized(selected).stage).toBe("write");
  expect(nextProjectFixtureResponse.toString()).not.toMatch(/\b(?:import|require|fetch)\s*\(/);
});

test("the separate project reply is unchanged and ambiguous fixture markers are rejected", () => {
  expect(nextProjectFixtureResponse(request("SMOKE_B", [])).delta.content).toBe(
    "Isolated project model replied.",
  );
  expect(() => nextProjectFixtureResponse(request("SMOKE_MAIN_RW SMOKE_PANEL_RW"))).toThrow(
    "ambiguous task",
  );
});
