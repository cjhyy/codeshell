import { describe, expect, test } from "bun:test";
import { createEventCoalescer } from "./streamCoalescer";
import type { StreamEvent } from "@cjhyy/code-shell-core";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createEventCoalescer", () => {
  test("13. two text_delta for the same agent merge into one flushed event", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "hello ", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "world", agentId: "A" } as any);
    await delay(50);
    expect(out).toEqual([
      { type: "text_delta", text: "hello world", agentId: "A" } as any,
    ]);
    c.dispose();
  });

  test("14. tool_use_args_delta merges by toolCallId via shallow-assign", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({
      type: "tool_use_args_delta",
      toolCallId: "t1",
      args: { a: 1 },
      agentId: "A",
    } as any);
    c.push({
      type: "tool_use_args_delta",
      toolCallId: "t1",
      args: { b: 2, a: 99 },
      agentId: "A",
    } as any);
    await delay(50);
    expect(out).toEqual([
      {
        type: "tool_use_args_delta",
        toolCallId: "t1",
        args: { a: 99, b: 2 },
        agentId: "A",
      } as any,
    ]);
    c.dispose();
  });

  test("15. tool_use_start flushes any pending text_delta first, in order", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "hi", agentId: "A" } as any);
    c.push({
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Read", args: {} },
      agentId: "A",
    } as any);
    // Both should be drained synchronously by the tool_use_start flush.
    expect(out.length).toBe(2);
    expect(out[0]!.type).toBe("text_delta");
    expect((out[0] as any).text).toBe("hi");
    expect(out[1]!.type).toBe("tool_use_start");
    c.dispose();
  });

  test("16. text_delta for agent A vs agent B do not merge", async () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "a1", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "b1", agentId: "B" } as any);
    c.push({ type: "text_delta", text: "a2", agentId: "A" } as any);
    await delay(50);
    // Two flushed events: A merged ("a1a2") and B alone ("b1").
    expect(out.length).toBe(2);
    const a = out.find((e) => (e as any).agentId === "A") as any;
    const b = out.find((e) => (e as any).agentId === "B") as any;
    expect(a.text).toBe("a1a2");
    expect(b.text).toBe("b1");
  });

  test("17. dispose() flushes any pending content synchronously", () => {
    const out: StreamEvent[] = [];
    const c = createEventCoalescer((e) => out.push(e), 30);
    c.push({ type: "text_delta", text: "pending", agentId: "A" } as any);
    c.dispose();
    expect(out.length).toBe(1);
    expect((out[0] as any).text).toBe("pending");
  });
});
