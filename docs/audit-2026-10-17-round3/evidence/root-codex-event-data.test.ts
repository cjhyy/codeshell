import { expect, test } from "bun:test";
import { parseCodexJsonLine } from "../../../packages/server/src/mobile-remote/codex-parse.ts";

test("R3-01 normal completed file_change with changes array produces no edit event", () => {
  const input = { type: "item.completed", item: { id: "file-1", type: "file_change", changes: [{ path: "/fixture/a.ts", kind: "update" }, { path: "/fixture/b.ts", kind: "add" }], status: "completed" } };
  const events = parseCodexJsonLine(JSON.stringify(input));
  console.log(JSON.stringify({ case: "completed-files", input, events }));
  expect(events).toEqual([]);
  // Even a started item with the real array shape produces an empty path.
  const early = parseCodexJsonLine(JSON.stringify({ ...input, type: "item.started" }));
  expect(early[0]).toMatchObject({ type: "tool", tool: "Edit", summary: "", input: { path: "" } });
});

test("R3-02 structured MCP success and error message lose readable result text", () => {
  const success = { type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "fixture", tool: "read", arguments: {}, result: { content: [{ type: "text", text: "readable fixture result" }], structured_content: { count: 1 } }, status: "completed" } };
  const failure = { type: "item.completed", item: { id: "mcp-2", type: "mcp_tool_call", server: "fixture", tool: "read", arguments: {}, error: { message: "fixture file is unavailable" }, status: "failed" } };
  const okEvents = parseCodexJsonLine(JSON.stringify(success));
  const badEvents = parseCodexJsonLine(JSON.stringify(failure));
  console.log(JSON.stringify({ case: "mcp-results", success: okEvents, failure: badEvents }));
  expect(okEvents).toEqual([{ type: "tool_result", id: "mcp-1", summary: "[object Object]", isError: false }]);
  expect(badEvents).toEqual([{ type: "tool_result", id: "mcp-2", summary: "", isError: true }]);
});

test("R3-03 non-object null JSON is thrown while malformed JSON noise is ignored", () => {
  expect(() => parseCodexJsonLine("null")).toThrow();
  expect(parseCodexJsonLine("not JSON")).toEqual([]);
  expect(parseCodexJsonLine(JSON.stringify({ type: "unknown.normal.record" }))).toEqual([]);
});

test("ordinary command output and final assistant text normal controls", () => {
  expect(parseCodexJsonLine(JSON.stringify({ type: "item.completed", item: { id: "command-1", type: "command_execution", aggregated_output: "fixture result", exit_code: 0 } }))).toEqual([{ type: "tool_result", id: "command-1", summary: "fixture result", isError: false }]);
  expect(parseCodexJsonLine(JSON.stringify({ type: "item.completed", item: { id: "text-1", type: "agent_message", text: "final fixture reply" } }))).toEqual([{ type: "text", text: "final fixture reply" }]);
});
