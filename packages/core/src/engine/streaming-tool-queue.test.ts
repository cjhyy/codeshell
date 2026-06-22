import { describe, test, expect } from "bun:test";
import { StreamingToolQueue } from "./streaming-tool-queue.js";
import type { ToolExecutor } from "../tool-system/executor.js";
import type { ToolCall, ToolResult } from "../types.js";

// A fake executor that lets each test decide how a given tool call behaves:
// resolve to a ToolResult, or REJECT (mirrors permission.handleAsk throwing
// outside executeSingle's try/catch). isConcurrencySafe is configurable so we
// can exercise both the "started immediately" and "unsafe queue" paths.
function fakeExecutor(opts: {
  behavior: (call: ToolCall) => Promise<ToolResult>;
  concurrencySafe?: (name: string) => boolean;
}): ToolExecutor {
  return {
    isConcurrencySafe: (name: string) => opts.concurrencySafe?.(name) ?? false,
    executeSingle: (call: ToolCall) => opts.behavior(call),
  } as unknown as ToolExecutor;
}

function call(id: string, toolName = "T"): ToolCall {
  return { id, toolName, args: {} } as unknown as ToolCall;
}

describe("StreamingToolQueue.drain result integrity", () => {
  test("a rejecting tool does not lose results for the OTHER tools, and yields no undefined", async () => {
    const exec = fakeExecutor({
      concurrencySafe: () => true, // all start immediately
      behavior: async (c) => {
        if (c.id === "b") throw new Error("handleAsk blew up");
        return { id: c.id, toolName: c.toolName, result: `ok-${c.id}` } as ToolResult;
      },
    });
    const q = new StreamingToolQueue(exec);
    q.enqueue(call("a"));
    q.enqueue(call("b")); // this one rejects
    q.enqueue(call("c"));

    const results = await q.drain();

    // Every enqueued call must have a result, in order, with NO undefined holes.
    expect(results.length).toBe(3);
    expect(results.every((r) => r != null)).toBe(true);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // a and c succeeded
    expect((results[0] as ToolResult).result).toBe("ok-a");
    expect((results[2] as ToolResult).result).toBe("ok-c");
    // b became a synthetic error result rather than vanishing or crashing drain
    expect(results[1].isError).toBe(true);
    expect(String(results[1].error)).toContain("handleAsk blew up");
  });

  test("a rejecting UNSAFE tool still lets later unsafe tools run", async () => {
    const ran: string[] = [];
    const exec = fakeExecutor({
      concurrencySafe: () => false, // all sequential
      behavior: async (c) => {
        ran.push(c.id);
        if (c.id === "x") throw new Error("nope");
        return { id: c.id, toolName: c.toolName, result: `ok-${c.id}` } as ToolResult;
      },
    });
    const q = new StreamingToolQueue(exec);
    q.enqueue(call("x")); // rejects
    q.enqueue(call("y"));

    const results = await q.drain();

    expect(ran).toEqual(["x", "y"]); // y still executed after x threw
    expect(results.map((r) => r.id)).toEqual(["x", "y"]);
    expect(results[0].isError).toBe(true);
    expect((results[1] as ToolResult).result).toBe("ok-y");
  });
});
