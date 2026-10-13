// Pure, serializable model-fixture policy. No Core, transport or process imports.
// The real default coding preset defers Write until ToolSearch selects it. Keep
// that path, while Panel tasks with an explicit Read/Write allowlist stay direct.
export function nextProjectFixtureResponse(body) {
  const check = (condition, detail) => {
    if (!condition) throw new Error(`Project model fixture refused: ${detail}`);
  };
  const messages = body.messages ?? [];
  check(Array.isArray(messages), "invalid messages");
  const userIndex = messages.findLastIndex(
    (message) => message.role === "user" && JSON.stringify(message.content).includes("SMOKE_"),
  );
  const task = JSON.stringify(messages[userIndex]?.content ?? "");
  const independent = task.includes("SMOKE_PANEL_RW");
  const main = task.includes("SMOKE_MAIN_RW");
  check(!(main && independent), "ambiguous task");
  const reply = (text, stage) => ({
    stage,
    delta: { role: "assistant", content: text },
    finishReason: "stop",
  });
  if (!main && !independent) return reply("Isolated project model replied.", "isolated-reply");

  check(Array.isArray(body.tools) && body.tools.length > 0, "missing advertised tools");
  const tools = new Set(body.tools.map((tool) => tool.function?.name));
  const calls = new Map();
  const results = [];
  const sequence = independent ? ["Read", "Write"] : ["Read", "ToolSearch", "Write"];
  for (let index = userIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && message.tool_calls) {
      check(
        Array.isArray(message.tool_calls) && message.tool_calls.length === 1,
        "fixture tools must run in separate model steps",
      );
      const call = message.tool_calls[0];
      check(
        typeof call.id === "string" && call.id.length > 0 && !calls.has(call.id),
        "invalid tool call identity",
      );
      calls.set(call.id, { name: call.function?.name, index });
    } else if (message.role === "tool") {
      const call = calls.get(message.tool_call_id);
      check(call && call.name === sequence[results.length], "unexpected tool result sequence");
      check(
        !results.length || call.index > results.at(-1).index,
        "selection applies only to the next model step",
      );
      results.push({
        name: call.name,
        content:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        index,
      });
    }
  }
  check(results.length <= sequence.length, "unexpected extra tool results");
  if (results.length) {
    const priorProof = independent
      ? "written by main agent after Read"
      : "written by panel process";
    check(results[0].content.includes(priorProof), "Read did not return the prior writer proof");
  }
  if (main && results.length >= 2) {
    check(
      results[1].content.includes("Selected tools for this run: Write.") &&
        results[1].content.includes("schemaRef: select:Write") &&
        !results[1].content.includes('Tool "Write" is not available'),
      "ToolSearch did not select Write",
    );
  }
  if (results.length === sequence.length)
    return reply("Shared file Read and Write completed.", "completed");

  const name = sequence[results.length];
  check(tools.has(name), "required tool schema was not advertised");
  if (main && results.length < 2) {
    check(tools.has("ToolSearch"), "default preset discovery is missing");
    check(!tools.has("Write"), "Write appeared before explicit discovery");
  }
  const args =
    name === "ToolSearch"
      ? { query: "select:Write" }
      : {
          file_path: "/workspace/downloads/shared-proof.txt",
          ...(name === "Write"
            ? {
                content: independent
                  ? "written by independent panel task after Read\n"
                  : "written by main agent after Read\n",
              }
            : {}),
        };
  return {
    stage: name === "ToolSearch" ? "select-write" : name.toLowerCase(),
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `smoke-${independent ? "panel" : "main"}-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    finishReason: "tool_calls",
  };
}
