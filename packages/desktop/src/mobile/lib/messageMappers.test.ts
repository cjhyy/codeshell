import { test, expect } from "bun:test";
import { roomMsgToEvent, extractAskUserOptions } from "./messageMappers";
import { reduceStream, initialChatState } from "./streamReducer";

test("roomMsgToEvent 映射各类型", () => {
  expect(roomMsgToEvent({ from: "user", text: "hi" })).toEqual({ type: "user_message", text: "hi" });
  expect(roomMsgToEvent({ from: "agent", type: "text_delta", text: "x" })).toEqual({ type: "text_delta", text: "x" });
  expect(roomMsgToEvent({ from: "agent", type: "tool", tool: "Read", seq: 3 })).toEqual({
    type: "tool_use_start",
    toolCall: { id: "3", toolName: "Read", args: {} },
  });
  expect(roomMsgToEvent({ from: "agent", type: "turn_end", reason: "completed" })).toEqual({
    type: "turn_complete",
    reason: "completed",
  });
  expect((roomMsgToEvent({ from: "system", type: "agent_exit", code: 1 }) as { type: string }).type).toBe("error");
});

test("房间消息经 roomMsgToEvent → reducer 重建对话", () => {
  const msgs = [
    { from: "user", text: "看仓库" },
    { from: "agent", type: "text_delta", text: "好" },
    { from: "agent", type: "tool", tool: "Glob", seq: 2 },
    { from: "agent", type: "turn_end", reason: "completed" },
  ];
  const state = msgs.map(roomMsgToEvent).reduce(reduceStream, initialChatState());
  expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
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
