import { describe, expect, test } from "bun:test";
import { createEventCoalescer } from "./streamCoalescer";
import type { StreamEvent } from "@cjhyy/code-shell-core";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collector that flattens batched flushes back into a flat event list, plus
 *  records how many batches (= reducer dispatches) were emitted. */
function collector() {
  const out: StreamEvent[] = [];
  let batches = 0;
  const onFlush = (events: StreamEvent[]) => {
    batches += 1;
    out.push(...events);
  };
  return { out, onFlush, get batches() { return batches; } };
}

describe("createEventCoalescer", () => {
  test("13. two text_delta for the same agent merge into one flushed event", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "hello ", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "world", agentId: "A" } as any);
    await delay(50);
    expect(c1.out).toEqual([
      { type: "text_delta", text: "hello world", agentId: "A" } as any,
    ]);
    c.dispose();
  });

  test("14. tool_use_args_delta merges by toolCallId via shallow-assign", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "tool_use_args_delta", toolCallId: "t1", args: { a: 1 }, agentId: "A" } as any);
    c.push({ type: "tool_use_args_delta", toolCallId: "t1", args: { b: 2, a: 99 }, agentId: "A" } as any);
    await delay(50);
    expect(c1.out).toEqual([
      { type: "tool_use_args_delta", toolCallId: "t1", args: { a: 99, b: 2 }, agentId: "A" } as any,
    ]);
    c.dispose();
  });

  test("15. pending text_delta then tool_use_start flush in arrival order", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "hi", agentId: "A" } as any);
    c.push({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: {} }, agentId: "A" } as any);
    await delay(50);
    expect(c1.out.length).toBe(2);
    expect(c1.out[0]!.type).toBe("text_delta");
    expect((c1.out[0] as any).text).toBe("hi");
    expect(c1.out[1]!.type).toBe("tool_use_start");
    c.dispose();
  });

  test("16. text_delta for agent A vs agent B do not merge", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "a1", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "b1", agentId: "B" } as any);
    c.push({ type: "text_delta", text: "a2", agentId: "A" } as any);
    await delay(50);
    expect(c1.out.length).toBe(2);
    const a = c1.out.find((e) => (e as any).agentId === "A") as any;
    const b = c1.out.find((e) => (e as any).agentId === "B") as any;
    expect(a.text).toBe("a1a2");
    expect(b.text).toBe("b1");
  });

  test("17. dispose() flushes any pending content synchronously", () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "pending", agentId: "A" } as any);
    c.dispose();
    expect(c1.out.length).toBe(1);
    expect((c1.out[0] as any).text).toBe("pending");
  });

  test("18. a burst of boundary events in one window flushes as ONE batch", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    // Simulate a tool-heavy sub-agent: many start/result pairs in one window.
    for (let i = 0; i < 10; i++) {
      c.push({ type: "tool_use_start", toolCall: { id: `t${i}`, toolName: "Read", args: {} } } as any);
      c.push({ type: "tool_result", result: { id: `t${i}`, toolName: "Read", result: "ok" } } as any);
    }
    await delay(50);
    // 20 events, but ONE dispatch — the whole point of the perf fix.
    expect(c1.batches).toBe(1);
    expect(c1.out.length).toBe(20);
    expect(c1.out[0]!.type).toBe("tool_use_start");
    expect(c1.out[19]!.type).toBe("tool_result");
    c.dispose();
  });

  test("19. error flushes immediately and on its own", () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "before", agentId: "A" } as any);
    c.push({ type: "error", message: "boom" } as any);
    // Synchronous: pending batch first (with the text), then the error batch.
    expect(c1.batches).toBe(2);
    expect((c1.out[0] as any).text).toBe("before");
    expect(c1.out[1]!.type).toBe("error");
    c.dispose();
  });
});
