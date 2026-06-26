import { describe, expect, it, test } from "bun:test";
import { parseStreamJsonLine, buildControlResponse } from "./resident-agent.js";

describe("buildControlResponse", () => {
  // The stdio control protocol's Zod schema requires `updatedInput` to be a
  // record on the allow branch — omitting it makes claude reject the whole
  // control_response (ZodError invalid_union) and the tool silently fails.
  it("allow WITHOUT updatedInput is defaulted to an empty record (never undefined)", () => {
    const resp = buildControlResponse("req1", { behavior: "allow" });
    expect(resp.response.request_id).toBe("req1");
    expect(resp.response.response).toEqual({ behavior: "allow", updatedInput: {} });
  });
  it("allow WITH updatedInput preserves it", () => {
    const resp = buildControlResponse("req2", { behavior: "allow", updatedInput: { file_path: "/a.txt" } });
    expect(resp.response.response).toEqual({ behavior: "allow", updatedInput: { file_path: "/a.txt" } });
  });
  it("deny is passed through unchanged (no updatedInput injected)", () => {
    const resp = buildControlResponse("req3", { behavior: "deny", message: "no" });
    expect(resp.response.response).toEqual({ behavior: "deny", message: "no" });
  });
  it("wraps in the control_response envelope claude expects", () => {
    const resp = buildControlResponse("r", { behavior: "allow", updatedInput: {} });
    expect(resp.type).toBe("control_response");
    expect(resp.response.subtype).toBe("success");
  });
});

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

  test("extracts tool_use with arg summary AND its tool_use id (for pairing)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls package.json" } }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool", id: "toolu_01", tool: "Bash", summary: "ls package.json" },
    ]);
  });

  test("tool_use with no id falls back to undefined id (old transcripts / malformed)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool", id: undefined, tool: "Bash", summary: "ls" },
    ]);
  });

  test("extracts tool_result (claude-fed user message) with its tool_use_id", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "package.json\n" }] },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool_result", id: "toolu_01", summary: "package.json\n", isError: false },
    ]);
  });

  test("flags tool_result errors and carries the id", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_02", is_error: true, content: "boom" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "tool_result", id: "toolu_02", summary: "boom", isError: true },
    ]);
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
          { type: "tool_use", id: "toolu_x", name: "Read", input: { file_path: "/a/b.ts" } },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool", id: "toolu_x", tool: "Read", summary: "/a/b.ts" },
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
