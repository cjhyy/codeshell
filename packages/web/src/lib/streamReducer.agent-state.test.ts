import { expect, test } from "bun:test";
import { initialChatState, reduceStream, type ChatState } from "./streamReducer";

const childEvents = [
  { type: "stream_request_start" },
  { type: "text_delta", text: "Owned child" },
  { type: "thinking_delta", text: "Owned child reasoning" },
  { type: "tool_use_start", toolCall: { id: "owned-child-tool", toolName: "Read", args: {} } },
];
for (const run of ["idle", "completed", "waiting", "error"] as const) {
  test.each(childEvents)(
    `child $type preserves parent ${run} across start and continuation`,
    (event) => {
      let state: ChatState = { ...initialChatState(), run };
      for (let i = 0; i < 2; i++) {
        state = reduceStream(state, { ...event, agentId: "owned-child" });
        expect(state.run).toBe(run);
      }
      state = reduceStream(state, { type: "assistant_message", agentId: "owned-child" });
      state = reduceStream(state, {
        type: "turn_complete",
        agentId: "owned-child",
        reason: "completed",
      });
      state = reduceStream(state, { type: "agent_end", agentId: "owned-child" });
      expect(state.run).toBe(run);
      expect(state.liveByAgent).toEqual({});
    },
  );
}

test("a child error seals its bubble while the parent and another child keep accumulating", () => {
  let state = initialChatState();
  for (const agentId of [undefined, "child-a", "child-b"]) {
    state = reduceStream(state, { type: "stream_request_start", agentId });
    state = reduceStream(state, { type: "text_delta", agentId, text: agentId ?? "parent" });
  }
  const parentId = state.liveByAgent[""];
  const otherId = state.liveByAgent["child-b"];
  state = reduceStream(state, { type: "error", agentId: "child-a", error: "Owned child failure" });
  expect(state.run).toBe("running");
  expect(state.liveByAgent).toEqual({ "": parentId, "child-b": otherId });
  expect(
    state.items.find((item) => item.kind === "assistant" && item.agentId === "child-a"),
  ).toMatchObject({ done: true });
  state = reduceStream(state, { type: "text_delta", text: " continues" });
  expect(state.items.find((item) => item.id === parentId)).toMatchObject({
    text: "parent continues",
    done: false,
  });
  state = reduceStream(state, { type: "turn_complete", reason: "completed" });
  expect(state.run).toBe("completed");
  expect(state.liveByAgent).toEqual({ "child-b": otherId });
});

test("main lifecycle and main errors still control global run", () => {
  let state = initialChatState();
  state = reduceStream(state, { type: "text_delta", text: "Owned main" });
  expect(state.run).toBe("running");
  state = reduceStream(state, { type: "error", error: "Owned main failure" });
  expect(state.run).toBe("error");
  expect(state.liveByAgent).toEqual({});
});

test.each([false, true])(
  "orphan result normalizes exactly like ordered result (error=%s)",
  (isError) => {
    const start = {
      type: "tool_use_start",
      toolCall: { id: "owned-tool", toolName: "Read", args: {} },
    };
    const result = {
      type: "tool_result",
      result: {
        id: "owned-tool",
        result: "Visible answer.\n<system-reminder>Owned model note</system-reminder>\n",
        isError,
      },
    };
    const feed = (events: unknown[]) =>
      events.reduce(reduceStream, initialChatState()) as ChatState;
    const ordered = feed([start, result]).items.find((item) => item.kind === "tool");
    const orphaned = feed([result, start]).items.find((item) => item.kind === "tool");
    expect(orphaned).toEqual(ordered);
    expect(orphaned).toMatchObject({ result: "Visible answer.\n", error: isError, done: true });
  },
);
