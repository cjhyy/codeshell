import { describe, expect, test } from "bun:test";
import { chatReducer } from "../hooks/remoteChatReducer";
import { createStreamBatcher, type StreamBatcherScheduler } from "./streamBatcher";
import { initialChatState, reduceScopedStream } from "./streamReducer";

function ev(event: Record<string, unknown>, sessionId = "s1") {
  return { method: "agent/streamEvent", params: { event, sessionId } };
}

/** Manually driven frame/timeout queue. */
function manualScheduler() {
  const frames = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const scheduler: StreamBatcherScheduler = {
    frame: (callback) => {
      frames.add(callback);
      return () => frames.delete(callback);
    },
    timeout: (callback) => {
      timeouts.add(callback);
      return () => timeouts.delete(callback);
    },
  };
  const run = (set: Set<() => void>) => {
    for (const callback of [...set]) {
      set.delete(callback);
      callback();
    }
  };
  return {
    scheduler,
    frames,
    timeouts,
    runFrame: () => run(frames),
    runTimeout: () => run(timeouts),
  };
}

describe("createStreamBatcher", () => {
  test("buffers deltas and applies them in arrival order in one flush per frame", () => {
    const clock = manualScheduler();
    const flushes: unknown[][] = [];
    const batcher = createStreamBatcher((events) => flushes.push(events), {
      scheduler: clock.scheduler,
    });
    const events = [
      ev({ type: "text_delta", text: "a" }),
      ev({ type: "thinking_delta", text: "b" }),
      ev({ type: "tool_use_args_delta", toolCallId: "t", args: {} }),
      ev({ type: "text_delta", text: "c" }),
    ];
    for (const e of events) batcher.push(e);
    expect(flushes).toEqual([]);
    expect(batcher.pending).toBe(4);
    // One frame + one fallback timer, not one per event.
    expect(clock.frames.size).toBe(1);
    expect(clock.timeouts.size).toBe(1);

    clock.runFrame();
    expect(flushes).toEqual([events]);
    // The fallback timer was cancelled by the frame flush.
    expect(clock.timeouts.size).toBe(0);
    expect(batcher.pending).toBe(0);
  });

  test("falls back to the timeout when frames stall (hidden tab)", () => {
    const clock = manualScheduler();
    const flushes: unknown[][] = [];
    const batcher = createStreamBatcher((events) => flushes.push(events), {
      scheduler: clock.scheduler,
    });
    batcher.push(ev({ type: "text_delta", text: "x" }));
    clock.runTimeout();
    expect(flushes).toHaveLength(1);
    expect(clock.frames.size).toBe(0);
  });

  test("non-delta events flush immediately together with everything before them", () => {
    const clock = manualScheduler();
    const flushes: unknown[][] = [];
    const batcher = createStreamBatcher((events) => flushes.push(events), {
      scheduler: clock.scheduler,
    });
    const delta = ev({ type: "text_delta", text: "done" });
    const complete = ev({ type: "turn_complete", reason: "completed" });
    batcher.push(delta);
    batcher.push(complete);
    expect(flushes).toEqual([[delta, complete]]);
    expect(clock.frames.size + clock.timeouts.size).toBe(0);

    const error = ev({ type: "error", error: "boom" });
    batcher.push(error);
    expect(flushes[1]).toEqual([error]);

    // Run-state boundaries are not held behind a frame either.
    const start = ev({ type: "stream_request_start" });
    const echo = ev({ type: "session_user_message", text: "hi", clientMessageId: "c1" });
    batcher.push(echo);
    batcher.push(start);
    expect(flushes.slice(2)).toEqual([[echo], [start]]);
  });

  test("explicit flush applies pending events before a dependent action; discard drops them", () => {
    const clock = manualScheduler();
    const flushes: unknown[][] = [];
    const batcher = createStreamBatcher((events) => flushes.push(events), {
      scheduler: clock.scheduler,
    });
    batcher.flush();
    expect(flushes).toEqual([]);
    batcher.push(ev({ type: "text_delta", text: "a" }));
    batcher.flush();
    expect(flushes).toHaveLength(1);
    batcher.push(ev({ type: "text_delta", text: "b" }));
    batcher.discard();
    clock.runFrame();
    clock.runTimeout();
    expect(flushes).toHaveLength(1);
  });

  test("a batched append reduces to the same state as per-event raw dispatches", () => {
    const events = [
      ev({ type: "session_user_message", text: "hi" }),
      ev({ type: "stream_request_start" }),
      ev({ type: "thinking_delta", text: "hmm" }),
      ev({ type: "text_delta", text: "Hel" }),
      ev({ type: "text_delta", text: "lo" }),
      ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: {} } }),
      ev({ type: "tool_result", toolCallId: "t1", result: "ok" }),
      ev({ type: "stream_request_start" }),
      ev({ type: "text_delta", text: "after" }),
      ev({ type: "turn_complete", reason: "completed" }),
    ];
    const perEvent = events.reduce(
      (state, raw) => chatReducer(state, { kind: "raw", raw }),
      initialChatState(),
    );
    const clock = manualScheduler();
    let batched = initialChatState();
    const batcher = createStreamBatcher(
      (batch) => {
        batched = chatReducer(batched, { kind: "append", events: batch });
      },
      { scheduler: clock.scheduler },
    );
    for (const e of events) batcher.push(e);
    expect(batched).toEqual(perEvent);
    expect(perEvent).toEqual(events.reduce(reduceScopedStream, initialChatState()));
    const assistants = perEvent.items.filter((item) => item.kind === "assistant");
    expect(assistants.map((item) => item.text)).toEqual(["Hello", "after"]);
  });
});
