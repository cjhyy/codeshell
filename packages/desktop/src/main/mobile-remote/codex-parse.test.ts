import { describe, expect, it, test } from "bun:test";
import { parseCodexJsonLine, extractThreadId } from "./codex-parse.js";

describe("parseCodexJsonLine", () => {
  test("ignores noise / unparseable / thread.started / turn.started / reasoning", () => {
    expect(parseCodexJsonLine("")).toEqual([]);
    expect(parseCodexJsonLine("not json")).toEqual([]);
    expect(parseCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "T" }))).toEqual([]);
    expect(parseCodexJsonLine(JSON.stringify({ type: "turn.started" }))).toEqual([]);
    // reasoning is thinking noise — not part of the render-friendly union
    expect(parseCodexJsonLine(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "hmm" } }))).toEqual([]);
  });

  test("agent_message (completed) → text", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "text", text: "done" }]);
  });

  test("agent_message only emits on completed, not started (avoid dup)", () => {
    const line = JSON.stringify({ type: "item.started", item: { id: "i1", type: "agent_message", text: "partial" } });
    expect(parseCodexJsonLine(line)).toEqual([]);
  });

  test("command_execution started → tool(Bash) carrying the item id", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "i0", type: "command_execution", command: "echo hi", status: "in_progress" },
    });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "tool", id: "i0", tool: "Bash", summary: "echo hi" }]);
  });

  test("command_execution completed → tool_result paired by id, isError from exit_code", () => {
    const ok = JSON.stringify({
      type: "item.completed",
      item: { id: "i0", type: "command_execution", command: "echo hi", aggregated_output: "hi\n", exit_code: 0 },
    });
    expect(parseCodexJsonLine(ok)).toEqual([{ type: "tool_result", id: "i0", summary: "hi\n", isError: false }]);

    const bad = JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1 },
    });
    expect(parseCodexJsonLine(bad)).toEqual([{ type: "tool_result", id: "i1", summary: "", isError: true }]);
  });

  test("mcp_tool_call → tool named <server>__<tool> (started) + tool_result (completed)", () => {
    const started = JSON.stringify({
      type: "item.started",
      item: { id: "m0", type: "mcp_tool_call", server: "fs", tool: "read", status: "in_progress" },
    });
    expect(parseCodexJsonLine(started)).toEqual([{ type: "tool", id: "m0", tool: "fs__read", summary: "" }]);
    const done = JSON.stringify({
      type: "item.completed",
      item: { id: "m0", type: "mcp_tool_call", server: "fs", tool: "read", result: "ok", status: "completed" },
    });
    expect(parseCodexJsonLine(done)).toEqual([{ type: "tool_result", id: "m0", summary: "ok", isError: false }]);
  });

  test("web_search → tool(WebSearch)", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "w0", type: "web_search", query: "codex cli" },
    });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "tool", id: "w0", tool: "WebSearch", summary: "codex cli" }]);
  });

  test("file_change → tool(Edit) with the path summary", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "f0", type: "file_change", path: "/a/b.ts", kind: "modify" },
    });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "tool", id: "f0", tool: "Edit", summary: "/a/b.ts" }]);
  });

  test("turn.completed → turn_end", () => {
    expect(parseCodexJsonLine(JSON.stringify({ type: "turn.completed", usage: {} }))).toEqual([
      { type: "turn_end", reason: "completed" },
    ]);
  });

  test("turn.failed → error with the failure message", () => {
    const line = JSON.stringify({ type: "turn.failed", error: { message: "model exploded" } });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "error", error: "model exploded" }]);
  });

  test("standalone error event → error", () => {
    const line = JSON.stringify({ type: "error", message: "boom" });
    expect(parseCodexJsonLine(line)).toEqual([{ type: "error", error: "boom" }]);
  });

  test("never emits approval_request (codex has no per-tool approval)", () => {
    // Even a command execution must NOT produce an approval prompt — the sandbox
    // tier chosen at spawn is the only guardrail for codex rooms.
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "i0", type: "command_execution", command: "rm -rf /", status: "in_progress" },
    });
    const evs = parseCodexJsonLine(line);
    expect(evs.some((e) => e.type === "approval_request")).toBe(false);
  });
});

describe("extractThreadId", () => {
  test("returns the thread_id from a thread.started line", () => {
    const line = JSON.stringify({ type: "thread.started", thread_id: "019f-abc" });
    expect(extractThreadId(line)).toBe("019f-abc");
  });

  test("returns undefined for any non-thread.started line", () => {
    expect(extractThreadId(JSON.stringify({ type: "turn.started" }))).toBeUndefined();
    expect(extractThreadId(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }))).toBeUndefined();
  });

  test("returns undefined for unparseable / empty input", () => {
    expect(extractThreadId("")).toBeUndefined();
    expect(extractThreadId("not json")).toBeUndefined();
  });

  test("returns undefined if thread.started lacks a string thread_id", () => {
    expect(extractThreadId(JSON.stringify({ type: "thread.started" }))).toBeUndefined();
    expect(extractThreadId(JSON.stringify({ type: "thread.started", thread_id: 123 }))).toBeUndefined();
  });
});
