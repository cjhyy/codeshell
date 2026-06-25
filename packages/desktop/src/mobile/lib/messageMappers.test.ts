import { test, expect } from "bun:test";
import { roomMsgToEvent, roomHistoryToEvents, extractAskUserOptions } from "./messageMappers";
import { reduceStream, initialChatState } from "./streamReducer";

// These shapes MUST mirror what RoomManager actually writes (room-manager.ts
// onAgentEvent/send): agent prose is type:"text" (NOT "text_delta"), tools carry
// a `summary`, results are type:"tool_result", errors type:"error", and exits
// use `reason` (NOT `code`). The previous version of this test fed an invented
// `text_delta` shape, masking that real agent replies dropped to _noop.
test("roomMsgToEvent 映射真实 RoomManager 形状", () => {
  expect(roomMsgToEvent({ from: "user", type: "text", text: "hi" })).toEqual({
    type: "user_message",
    text: "hi",
  });
  expect(roomMsgToEvent({ from: "agent", type: "text", text: "好" })).toEqual({
    type: "text_delta",
    text: "好",
  });
  expect(roomMsgToEvent({ from: "agent", type: "tool", tool: "Read", summary: "读 a.ts", seq: 3 })).toEqual({
    type: "tool_use_start",
    toolCall: { id: "room-tool-3", toolName: "Read", summary: "读 a.ts" },
  });
  expect(roomMsgToEvent({ from: "agent", type: "tool_result", summary: "ok", isError: false })).toEqual({
    type: "room_tool_result",
    summary: "ok",
    isError: false,
  });
  expect(roomMsgToEvent({ from: "agent", type: "turn_end", reason: "completed" })).toEqual({
    type: "turn_complete",
    reason: "completed",
  });
  expect(roomMsgToEvent({ from: "system", type: "error", text: "boom" })).toEqual({
    type: "error",
    error: "boom",
  });
  expect((roomMsgToEvent({ from: "system", type: "agent_exit", reason: "1" }) as { type: string }).type).toBe("error");
  // The room_created audit anchor has no visible rendering.
  expect(roomMsgToEvent({ from: "system", type: "room_created", text: "cwd=…" })).toEqual({ type: "_noop" });
});

test("房间消息经 roomMsgToEvent → reducer 重建对话(真实形状)", () => {
  const msgs = [
    { from: "system", type: "room_created", text: "cwd=/x permission=default", seq: 1 },
    { from: "user", type: "text", text: "看仓库", seq: 2 },
    { from: "agent", type: "text", text: "好,我来看", seq: 3 },
    { from: "agent", type: "tool", tool: "Glob", summary: "**/*.ts", seq: 4 },
    { from: "agent", type: "tool_result", summary: "找到 12 个文件", isError: false, seq: 5 },
    { from: "agent", type: "turn_end", reason: "completed", seq: 6 },
  ];
  const state = msgs.map(roomMsgToEvent).reduce(reduceStream, initialChatState());
  // The agent's reply MUST render (regression: it used to drop to _noop).
  expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
  const assistant = state.items.find((i) => i.kind === "assistant") as { text: string };
  expect(assistant.text).toBe("好,我来看");
  const tool = state.items.find((i) => i.kind === "tool") as { done: boolean; result?: string };
  expect(tool.done).toBe(true);
  expect(tool.result).toBe("找到 12 个文件");
  expect(state.run).toBe("completed");
});

test("extractAskUserOptions:字符串选项 / 对象 label / optionsOnly", () => {
  expect(extractAskUserOptions({ options: ["A", "B"] })).toEqual({ options: ["A", "B"], optionsOnly: false });
  expect(extractAskUserOptions({ options: [{ label: "甲" }, { label: "乙" }], optionsOnly: true })).toEqual({
    options: ["甲", "乙"],
    optionsOnly: true,
  });
  expect(extractAskUserOptions({ command: "ls" })).toBeUndefined();
  expect(extractAskUserOptions(undefined)).toBeUndefined();
  expect(extractAskUserOptions({ options: [] })).toBeUndefined();
});

// room.history.ok comes off the WS from the (untrusted) host. `messages` may be
// missing or — on a malformed/hostile payload — not an array; `(x ?? []).map`
// only guards null/undefined, so a non-array would throw and white-screen the
// phone. roomHistoryToEvents guards Array.isArray.
test("roomHistoryToEvents 守卫非数组 messages(不抛/白屏)", () => {
  // valid array maps through roomMsgToEvent
  expect(roomHistoryToEvents([{ from: "user", type: "text", text: "hi" }])).toEqual([
    { type: "user_message", text: "hi" },
  ]);
  // missing / non-array → empty replay, NOT a throw
  expect(roomHistoryToEvents(undefined)).toEqual([]);
  expect(roomHistoryToEvents(null)).toEqual([]);
  expect(roomHistoryToEvents(123)).toEqual([]);
  expect(roomHistoryToEvents("oops")).toEqual([]);
  expect(roomHistoryToEvents({ length: 2 })).toEqual([]);
});
