import { describe, expect, test } from "bun:test";
import { createEventCoalescer, type SequencedStreamEvent } from "./streamCoalescer";
import type { StreamEvent } from "@cjhyy/code-shell-core";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collector that flattens batched flushes back into a flat event list, plus
 *  records how many batches (= reducer dispatches) were emitted. */
function collector() {
  const out: StreamEvent[] = [];
  const raw: SequencedStreamEvent[] = [];
  const batchItems: StreamEvent[][] = [];
  let batches = 0;
  const onFlush = (events: StreamEvent[], entries: SequencedStreamEvent[]) => {
    batches += 1;
    out.push(...events);
    raw.push(...entries);
    batchItems.push(events);
  };
  return {
    out,
    raw,
    batchItems,
    onFlush,
    get batches() {
      return batches;
    },
  };
}

describe("createEventCoalescer", () => {
  test("keeps interrupted and replacement runs separate when late deltas interleave", () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    const oldRun = { runId: "run-old", clientMessageId: "message-old" };
    const newRun = { runId: "run-new", clientMessageId: "message-new" };
    const input: SequencedStreamEvent[] = [
      {
        event: { type: "text_delta", text: "old ", tokens: 2, ...oldRun },
        seq: 11,
        epoch: "epoch-a",
      },
      {
        event: { type: "text_delta", text: "answer", tokens: 3, ...oldRun },
        seq: 12,
        epoch: "epoch-a",
      },
      {
        event: { type: "thinking_delta", text: "old reasoning", ...oldRun },
        seq: 13,
        epoch: "epoch-a",
      },
      {
        event: {
          type: "tool_use_args_delta",
          toolCallId: "reused-tool",
          args: { old: true },
          ...oldRun,
        },
        seq: 14,
        epoch: "epoch-a",
      },
      {
        event: {
          type: "tool_use_args_delta",
          toolCallId: "reused-tool",
          args: { part: 1 },
          ...oldRun,
        },
        seq: 15,
        epoch: "epoch-a",
      },
      // The replacement run can arrive before the stopped run's final events.
      { event: { type: "text_delta", text: "new answer", ...newRun }, seq: 1, epoch: "epoch-b" },
      {
        event: { type: "thinking_delta", text: "new reasoning", ...newRun },
        seq: 2,
        epoch: "epoch-b",
      },
      {
        event: {
          type: "tool_use_args_delta",
          toolCallId: "reused-tool",
          args: { new: true },
          ...newRun,
        },
        seq: 3,
        epoch: "epoch-b",
      },
      { event: { type: "text_delta", text: " late old", ...oldRun }, seq: 16, epoch: "epoch-a" },
      {
        event: { type: "thinking_delta", text: "late old reasoning", ...oldRun },
        seq: 17,
        epoch: "epoch-a",
      },
      {
        event: {
          type: "tool_use_args_delta",
          toolCallId: "reused-tool",
          args: { late: true },
          ...oldRun,
        },
        seq: 18,
        epoch: "epoch-a",
      },
      {
        event: { type: "text_delta", text: " continued new", ...newRun },
        seq: 4,
        epoch: "epoch-b",
      },
    ];

    for (const entry of input) c.push(entry.event, entry.seq, entry.epoch);
    // Each identity change flushes synchronously; the final new-run segment
    // remains buffered until the usual flush, never merging back into its first.
    expect(c1.batches).toBe(3);
    c.flush();
    expect(c1.batchItems).toEqual([
      [
        { type: "text_delta", text: "old answer", tokens: 5, ...oldRun },
        input[2]!.event,
        {
          type: "tool_use_args_delta",
          toolCallId: "reused-tool",
          args: { old: true, part: 1 },
          ...oldRun,
        },
      ],
      input.slice(5, 8).map(({ event }) => event),
      input.slice(8, 11).map(({ event }) => event),
      [input[11]!.event],
    ]);
    expect(c1.raw).toEqual(input);
    for (const [index, entry] of c1.raw.entries()) expect(entry.event).toBe(input[index]!.event);
    // Aggregation must not overwrite either original text/tokens or args.
    expect(input[0]!.event).toEqual({ type: "text_delta", text: "old ", tokens: 2, ...oldRun });
    expect(input[3]!.event).toEqual({
      type: "tool_use_args_delta",
      toolCallId: "reused-tool",
      args: { old: true },
      ...oldRun,
    });
    c.dispose();
    expect(c1.batches).toBe(4);
  });

  test.each([
    [
      { runId: "run-a", clientMessageId: "client" },
      { runId: "run-b", clientMessageId: "client" },
    ],
    [
      { runId: "run", clientMessageId: "client-a" },
      { runId: "run", clientMessageId: "client-b" },
    ],
    [{}, { runId: "run", clientMessageId: "client" }],
    [{ runId: "run", clientMessageId: "client" }, {}],
  ] as Array<
    [Pick<StreamEvent, "runId" | "clientMessageId">, Pick<StreamEvent, "runId" | "clientMessageId">]
  >)("splits all deltas when either run identity field changes (%j → %j)", (first, second) => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    const input: StreamEvent[] = [
      { type: "text_delta", text: "first", ...first },
      { type: "thinking_delta", text: "second", ...second },
      { type: "tool_use_args_delta", toolCallId: "tool", args: { first: true }, ...first },
      { type: "tool_use_args_delta", toolCallId: "tool", args: { second: true }, ...second },
      { type: "text_delta", text: "first again", ...first },
    ];
    for (const event of input) c.push(event);
    expect(c1.batches).toBe(4);
    c.dispose();
    expect(c1.out).toEqual(input);
    expect(c1.batches).toBe(5);
  });

  test("preserves identity and tokens while merging deltas in the same run", () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    const identity = { runId: "run", clientMessageId: "client", agentId: "agent" };
    c.push({ type: "text_delta", text: "one", ...identity });
    c.push({ type: "text_delta", text: "two", tokens: 4, ...identity });
    c.push({ type: "tool_use_args_delta", toolCallId: "tool", args: { a: 1 }, ...identity });
    c.push({ type: "tool_use_args_delta", toolCallId: "tool", args: { b: 2 }, ...identity });
    c.dispose();
    expect(c1.batches).toBe(1);
    expect(c1.out).toEqual([
      { type: "text_delta", text: "onetwo", tokens: 4, ...identity },
      { type: "tool_use_args_delta", toolCallId: "tool", args: { a: 1, b: 2 }, ...identity },
    ]);
  });

  test("13. two text_delta for the same agent merge into one flushed event", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "hello ", agentId: "A" } as any);
    c.push({ type: "text_delta", text: "world", agentId: "A" } as any);
    await delay(50);
    expect(c1.out).toEqual([{ type: "text_delta", text: "hello world", agentId: "A" } as any]);
    c.dispose();
  });

  test("14. tool_use_args_delta merges by toolCallId via shallow-assign", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "tool_use_args_delta", toolCallId: "t1", args: { a: 1 }, agentId: "A" } as any);
    c.push({
      type: "tool_use_args_delta",
      toolCallId: "t1",
      args: { b: 2, a: 99 },
      agentId: "A",
    } as any);
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
    c.push({
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Read", args: {} },
      agentId: "A",
    } as any);
    await delay(50);
    expect(c1.out.length).toBe(2);
    expect(c1.out[0]!.type).toBe("text_delta");
    expect((c1.out[0] as any).text).toBe("hi");
    expect(c1.out[1]!.type).toBe("tool_use_start");
    c.dispose();
  });

  test("15b. turn boundary splits text_delta segments within one batch", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "old" } as any);
    c.push({ type: "turn_complete", status: "completed" } as any);
    c.push({ type: "stream_request_start", turnNumber: 2 } as any);
    c.push({ type: "text_delta", text: "new" } as any);
    await delay(50);
    expect(c1.batches).toBe(1);
    expect(c1.out.map((e) => e.type)).toEqual([
      "text_delta",
      "turn_complete",
      "stream_request_start",
      "text_delta",
    ]);
    expect((c1.out[0] as any).text).toBe("old");
    expect((c1.out[3] as any).text).toBe("new");
    c.dispose();
  });

  test("15c. tool boundary keeps later text_delta after the tool_use_start", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "before", agentId: "A" } as any);
    c.push({
      type: "tool_use_start",
      toolCall: { id: "t1", toolName: "Read", args: {} },
      agentId: "A",
    } as any);
    c.push({ type: "text_delta", text: "after", agentId: "A" } as any);
    await delay(50);
    expect(c1.batches).toBe(1);
    expect(c1.out.map((e) => e.type)).toEqual(["text_delta", "tool_use_start", "text_delta"]);
    expect((c1.out[0] as any).text).toBe("before");
    expect((c1.out[2] as any).text).toBe("after");
    c.dispose();
  });

  test("15d. tool_result boundary splits args deltas for the same toolCallId", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "tool_use_args_delta", toolCallId: "t1", args: { a: 1 }, agentId: "A" } as any);
    c.push({
      type: "tool_result",
      result: { id: "t1", toolName: "Read", result: "ok" },
      agentId: "A",
    } as any);
    c.push({ type: "tool_use_args_delta", toolCallId: "t1", args: { b: 2 }, agentId: "A" } as any);
    await delay(50);
    expect(c1.batches).toBe(1);
    expect(c1.out.map((e) => e.type)).toEqual([
      "tool_use_args_delta",
      "tool_result",
      "tool_use_args_delta",
    ]);
    expect((c1.out[0] as any).args).toEqual({ a: 1 });
    expect((c1.out[2] as any).args).toEqual({ b: 2 });
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

  test("17b. discard() drops pending content and cancels its scheduled flush", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    c.push({ type: "text_delta", text: "orphan", agentId: "A" } as any);
    c.discard();
    await delay(50);
    expect(c1.out).toEqual([]);
    expect(c1.batches).toBe(0);
  });

  test("18. a burst of boundary events in one window flushes as ONE batch", async () => {
    const c1 = collector();
    const c = createEventCoalescer(c1.onFlush, 30);
    // Simulate a tool-heavy sub-agent: many start/result pairs in one window.
    for (let i = 0; i < 10; i++) {
      c.push({
        type: "tool_use_start",
        toolCall: { id: `t${i}`, toolName: "Read", args: {} },
      } as any);
      c.push({
        type: "tool_result",
        result: { id: `t${i}`, toolName: "Read", result: "ok" },
      } as any);
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
