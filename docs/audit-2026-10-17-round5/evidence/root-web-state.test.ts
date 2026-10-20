import { expect, test } from "bun:test";
import { initialChatState, reduceStream, type ChatState } from "../../../packages/web/src/lib/streamReducer.ts";
import { chatFromSnapshot } from "../../../packages/web/app/chat.ts";
import { wrapChildStream } from "../../../packages/core/src/engine/subagent-spawner.ts";

// All events and snapshot data are owned memory; no DOM, transport, model,
// provider or real child process. Assertions describe current wrong behavior.
function feed(events: unknown[]): ChatState {
  return events.reduce<ChatState>(reduceStream, initialChatState());
}

test("WEB-R5-01 child detail revives completed parent and child terminals never clear it", () => {
  let state = feed([
    { type: "stream_request_start" },
    { type: "text_delta", text: "Parent finished." },
    { type: "turn_complete", reason: "completed" },
  ]);
  expect(state.run).toBe("completed");
  const emit = wrapChildStream((event) => { state = reduceStream(state, event); }, "owned-background")!;
  emit({ type: "stream_request_start", turnNumber: 1 } as any);
  emit({ type: "thinking_delta", text: "Child work." });
  emit({ type: "text_delta", text: "Child result." });
  emit({ type: "assistant_message", text: "Child result." } as any);
  emit({ type: "turn_complete", reason: "completed" } as any);
  state = reduceStream(state, { type: "agent_end", agentId: "owned-background" });
  expect(state.run).toBe("running");
  expect(state.items.filter((item) => item.kind === "assistant").every((item) => item.done)).toBe(true);
  expect(state.liveByAgent).toEqual({});
  // Explicit host-main lifecycle is one recovery; child completion was not.
  expect(reduceStream(state, { type: "turn_complete", reason: "completed" }).run).toBe("completed");
});

test("WEB-R5-01 snapshot running=false is overridden by a later buffered child delta", () => {
  const result = chatFromSnapshot({ transcript: [], running: false } as any, [
    { event: { type: "text_delta", agentId: "owned-background", text: "Still working separately." } } as any,
    { event: { type: "turn_complete", agentId: "owned-background", reason: "completed" } } as any,
  ]);
  expect(result.chat.run).toBe("running");
  expect(result.chat.items).toHaveLength(1);
  expect(result.chat.items[0]).toMatchObject({ kind: "assistant", agentId: "owned-background", done: true });
});

test("WEB-R5-01 scoped child error changes main run and clears its live accumulator", () => {
  let state = feed([
    { type: "stream_request_start" },
    { type: "text_delta", text: "Main is still working." },
  ]);
  const parentLive = state.liveByAgent[""];
  const emit = wrapChildStream((event) => { state = reduceStream(state, event); }, "owned-child")!;
  emit({ type: "error", error: "Owned child failed." });
  expect(state.run).toBe("error");
  expect(state.liveByAgent[""]).toBeUndefined();
  expect(state.items.find((item) => item.id === parentLive)).toMatchObject({ done: false });
  // Matching child terminal is already guarded and cannot recover the main.
  emit({ type: "turn_complete", reason: "model_error" } as any);
  expect(state.run).toBe("error");
});

test("WEB-R5-02 buffered orphan result bypasses reminder stripping applied to ordered results", () => {
  const start = { type: "tool_use_start", toolCall: { id: "owned-tool", toolName: "Read", args: {} } };
  const result = { type: "tool_result", result: { id: "owned-tool", result: "Visible answer.\n<system-reminder>Owned model-only context.</system-reminder>\n" } };
  const ordered = feed([start, result]).items.find((item) => item.kind === "tool");
  const outOfOrder = feed([result, start]).items.find((item) => item.kind === "tool");
  expect(ordered).toMatchObject({ result: "Visible answer.\n", done: true });
  expect(outOfOrder).toMatchObject({ result: result.result.result, done: true });
  expect(outOfOrder).not.toEqual(ordered);
});
