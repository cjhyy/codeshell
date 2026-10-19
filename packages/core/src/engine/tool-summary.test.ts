import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolResult } from "../types.js";
import { generateToolUseSummary } from "./tool-summary.js";

function call(id: string, toolName: string, args: ToolCall["args"] = {}): ToolCall {
  return { id, toolName, args };
}

function result(call: ToolCall): ToolResult {
  return { id: call.id, toolName: call.toolName, result: "private output" };
}

describe("tool progress summaries", () => {
  test("routine batches need no auxiliary model requests or private inputs", async () => {
    const calls = [
      call("read-a", "Read", { file_path: "/private/a" }),
      call("read-b", "Read", { file_path: "/private/b" }),
      call("grep", "Grep", { pattern: "private pattern" }),
      call("todo", "TodoWrite"),
      call("patch", "ApplyPatch"),
    ];
    let requests = 0;
    const summary = await generateToolUseSummary(calls, calls.map(result).reverse(), async () => {
      requests += 1;
      throw new Error("The auxiliary provider is unavailable");
    });
    expect(summary).toBe("Read x2, Searched, Updated tasks, Applied patch");
    expect(requests).toBe(0);
    expect(summary).not.toContain("private");
  });

  test("launching a background command is not described as completing it", async () => {
    const calls = [call("launch", "Bash", { run_in_background: true })];
    const summary = await generateToolUseSummary(calls, calls.map(result), async () => {
      throw new Error("No model request expected");
    });
    expect(summary).toBe("Started background command");
  });

  test("failed tools are reported from their matching result", async () => {
    const calls = [call("read", "Read"), call("bash", "Bash")];
    const results = [
      { ...result(calls[1]!), isError: true, error: "private failure details" },
      result(calls[0]!),
    ];
    expect(await generateToolUseSummary(calls, results, async () => "unused")).toBe(
      "Finished 2 tools (1 failed)",
    );
  });

  test("skill discovery is not described as loading instructions", async () => {
    const calls = [
      call("search", "Skill", { query: "", offset: 10 }),
      call("load", "Skill", { skill: "example" }),
    ];
    expect(await generateToolUseSummary(calls, calls.map(result), async () => "unused")).toBe(
      "Searched skills, Loaded skill",
    );
  });

  test("specialized tools retain the asynchronous summary and cancellation signal", async () => {
    const controller = new AbortController();
    const calls = [call("plugin", "PluginTool")];
    let requests = 0;
    const summary = await generateToolUseSummary(
      calls,
      calls.map(result),
      async (_system, user, signal) => {
        requests += 1;
        expect(user).toContain("PluginTool");
        expect(signal).toBe(controller.signal);
        return "  Updated document  ";
      },
      controller.signal,
    );
    expect(summary).toBe("Updated document");
    expect(requests).toBe(1);
  });

  test("aborted or empty batches do not dispatch summaries", async () => {
    const calls = [call("plugin", "PluginTool")];
    let requests = 0;
    const summarize = async () => {
      requests += 1;
      return "unused";
    };
    expect(await generateToolUseSummary([], [], summarize)).toBeNull();
    expect(
      await generateToolUseSummary(calls, calls.map(result), summarize, AbortSignal.abort()),
    ).toBeNull();
    expect(requests).toBe(0);
  });
});
