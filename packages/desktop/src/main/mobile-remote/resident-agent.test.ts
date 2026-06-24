import { describe, expect, it, test } from "bun:test";
import { parseStreamJsonLine } from "./resident-agent.js";

describe("parseStreamJsonLine", () => {
  test("ignores system / init / hook / rate-limit noise", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "hook_started" }))).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: "rate_limit_event" }))).toEqual([]);
    expect(parseStreamJsonLine("")).toEqual([]);
    expect(parseStreamJsonLine("not json")).toEqual([]);
  });

  test("extracts assistant text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("extracts tool_use with arg summary", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls package.json" } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool", tool: "Bash", summary: "ls package.json" },
    ]);
  });

  test("extracts tool_result (claude-fed user message)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: [{ type: "text", text: "package.json\n" }] }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool_result", summary: "package.json\n", isError: false },
    ]);
  });

  test("flags tool_result errors", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: "tool_result", summary: "boom", isError: true }]);
  });

  test("maps result → turn_end with reason", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "result", subtype: "success" }))).toEqual([
      { type: "turn_end", reason: "success" },
    ]);
  });

  test("handles multiple content parts in one assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool", tool: "Read", summary: "/a/b.ts" },
    ]);
  });
});

describe("parseStreamJsonLine approval", () => {
  it("maps control_request can_use_tool to approval_request event", () => {
    const line = JSON.stringify({
      type: "control_request", request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write",
        input: { file_path: "/a.txt" }, description: "a.txt" },
    });
    const evs = parseStreamJsonLine(line);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "approval_request", requestId: "r1", toolName: "Write" });
  });
  it("still ignores system/init noise", () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
  });
});
