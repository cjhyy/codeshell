import { test, expect } from "bun:test";
import {
  roomMsgToEvent,
  roomHistoryToEvents,
  ccHistoryToEvents,
  extractAskUserOptions,
} from "./messageMappers";
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
  // Each agent prose line is a COMPLETE chunk → its own finished bubble
  // (assistant_text), not a token delta folded into one bubble.
  expect(roomMsgToEvent({ from: "agent", type: "text", text: "好" })).toEqual({
    type: "assistant_text",
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

// ccRoom.readHistory.ok carries core HistoryMessage shape ({role,text,tools?}),
// distinct from RoomManager's messages.jsonl. Prose comes first (its own
// assistant_text bubble), then tools — matching "说一句 → 干活".
test("ccHistoryToEvents 映射 HistoryMessage 形状 + 经 reducer 重建", () => {
  const msgs = [
    { role: "user", text: "看一下仓库" },
    {
      role: "assistant",
      text: "好,我用 Glob 扫一遍",
      tools: [{ name: "Glob", summary: "**/*.ts" }],
    },
  ];
  const events = ccHistoryToEvents(msgs);
  // user → (prose bubble, tool start, turn_complete)
  expect(events).toEqual([
    { type: "user_message", text: "看一下仓库" },
    { type: "assistant_text", text: "好,我用 Glob 扫一遍" },
    {
      type: "tool_use_start",
      toolCall: { id: "cc-hist-1-0", toolName: "Glob", summary: "**/*.ts" },
    },
    { type: "turn_complete", reason: "completed" },
  ]);
  const state = events.reduce(reduceStream, initialChatState());
  expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
  const assistant = state.items.find((i) => i.kind === "assistant") as { text: string };
  expect(assistant.text).toBe("好,我用 Glob 扫一遍");
});

// THE key fix (A): two separate agent prose lines in one turn must render as
// TWO bubbles, interleaved with the tool — not folded into one ("说一句 → 干活
// → 再说一句"). Pre-fix, text_delta folded both into a single open bubble.
test("一回合多条 text → 多个独立气泡,与工具穿插", () => {
  const msgs = [
    { from: "user", type: "text", text: "干活", seq: 1 },
    { from: "agent", type: "text", text: "我来看一下", seq: 2 },
    { from: "agent", type: "tool", tool: "Read", summary: "a.ts", toolId: "t1", seq: 3 },
    { from: "agent", type: "tool_result", summary: "内容", isError: false, toolId: "t1", seq: 4 },
    { from: "agent", type: "text", text: "找到了,这就改", seq: 5 },
    { from: "agent", type: "turn_end", reason: "completed", seq: 6 },
  ];
  const state = msgs.map(roomMsgToEvent).reduce(reduceStream, initialChatState());
  // user, assistant("我来看一下"), tool, assistant("找到了,这就改") — 两个独立气泡
  expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  const texts = state.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text);
  expect(texts).toEqual(["我来看一下", "找到了,这就改"]);
  // both finished (no streaming cursor stuck)
  expect(state.items.filter((i) => i.kind === "assistant").every((i) => (i as { done: boolean }).done)).toBe(true);
});

// Same untrusted-payload guard as roomHistoryToEvents: a non-array (or junk
// entries) must yield an empty/clean replay, never throw.
test("ccHistoryToEvents 守卫非数组 / 脏条目(不抛)", () => {
  expect(ccHistoryToEvents(undefined)).toEqual([]);
  expect(ccHistoryToEvents(null)).toEqual([]);
  expect(ccHistoryToEvents(42)).toEqual([]);
  expect(ccHistoryToEvents("x")).toEqual([]);
  // junk entries are skipped, valid ones survive
  expect(ccHistoryToEvents([null, { role: "user", text: "hi" }, 7])).toEqual([
    { type: "user_message", text: "hi" },
  ]);
  // assistant with no tools and empty text → just a turn boundary
  expect(ccHistoryToEvents([{ role: "assistant", text: "" }])).toEqual([
    { type: "turn_complete", reason: "completed" },
  ]);
});

// Bug: tools stacked forever in a CC room until a session switch re-rendered
// from disk. Root cause: tool_result had no id, so the reducer "sealed the last
// open tool" — wrong when a turn runs tools in parallel. When room messages
// carry a `toolId`, the mapper must use it as the tool_use_start id AND emit an
// id-paired `tool_result` (not the id-less `room_tool_result`).
test("roomMsgToEvent:有 toolId 时用真 id + 走 id-配对的 tool_result", () => {
  expect(
    roomMsgToEvent({ from: "agent", type: "tool", tool: "Read", summary: "读 a.ts", toolId: "toolu_01", seq: 3 }),
  ).toEqual({
    type: "tool_use_start",
    toolCall: { id: "toolu_01", toolName: "Read", summary: "读 a.ts" },
  });
  expect(
    roomMsgToEvent({ from: "agent", type: "tool_result", summary: "ok", isError: false, toolId: "toolu_01" }),
  ).toEqual({
    type: "tool_result",
    result: { id: "toolu_01", result: "ok", isError: false },
  });
});

// A driven agent's tool call carries FULL structured args (the tool_use input —
// e.g. a sub-agent Task's multi-paragraph `prompt`), not just the one-field
// `summary`. roomMsgToEvent must forward `args` so the tool card can show the
// real parameters. When a (legacy) message has no `args`, the key is omitted so
// the older exact-shape tests stay green.
test("roomMsgToEvent 透传完整 args(prompt 等不再只剩 summary)", () => {
  const args = { description: "build X", prompt: "一大段子任务 prompt……", subagent_type: "general-purpose" };
  expect(
    roomMsgToEvent({ from: "agent", type: "tool", tool: "Agent", summary: "build X", args, toolId: "t9", seq: 7 }),
  ).toEqual({
    type: "tool_use_start",
    toolCall: { id: "t9", toolName: "Agent", summary: "build X", args },
  });
  // No args on the message → no args key on the event (legacy shape preserved).
  expect(
    roomMsgToEvent({ from: "agent", type: "tool", tool: "Read", summary: "a.ts", seq: 3 }),
  ).toEqual({
    type: "tool_use_start",
    toolCall: { id: "room-tool-3", toolName: "Read", summary: "a.ts" },
  });
});

test("ccHistoryToEvents 透传 tools[].args", () => {
  const args = { prompt: "做点啥", subagent_type: "general-purpose" };
  const events = ccHistoryToEvents([
    { role: "assistant", text: "", tools: [{ name: "Agent", summary: "做点啥", args }] },
  ]);
  expect(events).toEqual([
    {
      type: "tool_use_start",
      toolCall: { id: "cc-hist-0-0", toolName: "Agent", summary: "做点啥", args },
    },
    { type: "turn_complete", reason: "completed" },
  ]);
});

test("透传的 args 经 reducer 落到 tool item(卡片可展示完整参数)", () => {
  const args = { prompt: "完整 prompt 文本", description: "子任务" };
  const state = [
    { from: "user", type: "text", text: "跑个子代理", seq: 1 },
    { from: "agent", type: "tool", tool: "Agent", summary: "子任务", args, toolId: "t1", seq: 2 },
    { from: "agent", type: "tool_result", summary: "done", isError: false, toolId: "t1", seq: 3 },
    { from: "agent", type: "turn_end", reason: "completed", seq: 4 },
  ]
    .map(roomMsgToEvent)
    .reduce(reduceStream, initialChatState());
  const tool = state.items.find((i) => i.kind === "tool") as { args?: Record<string, unknown> };
  expect(tool.args).toEqual(args);
});

test("并行工具按 id 各自收口(回归:不再封错/堆叠)", () => {
  const msgs = [
    { from: "user", type: "text", text: "并行跑两个", seq: 1 },
    { from: "agent", type: "tool", tool: "Read", summary: "a.ts", toolId: "t1", seq: 2 },
    { from: "agent", type: "tool", tool: "Read", summary: "b.ts", toolId: "t2", seq: 3 },
    // Results arrive in the SAME order as starts — "seal last open" would attach
    // r1 to t2 (the most recent open) and leave t1 stuck. id-pairing fixes both.
    { from: "agent", type: "tool_result", summary: "A内容", isError: false, toolId: "t1", seq: 4 },
    { from: "agent", type: "tool_result", summary: "B内容", isError: false, toolId: "t2", seq: 5 },
    { from: "agent", type: "turn_end", reason: "completed", seq: 6 },
  ];
  const state = msgs.map(roomMsgToEvent).reduce(reduceStream, initialChatState());
  const tools = state.items.filter((i) => i.kind === "tool") as {
    id: string;
    done: boolean;
    result?: string;
  }[];
  expect(tools).toHaveLength(2);
  expect(tools.every((t) => t.done)).toBe(true);
  expect(tools.find((t) => t.id === "t1")?.result).toBe("A内容");
  expect(tools.find((t) => t.id === "t2")?.result).toBe("B内容");
});

test("无 toolId(旧 transcript)仍回退到 room-tool seq id + room_tool_result", () => {
  // Back-compat: messages persisted before the id fix have no toolId.
  expect(roomMsgToEvent({ from: "agent", type: "tool", tool: "Read", summary: "x", seq: 7 })).toEqual({
    type: "tool_use_start",
    toolCall: { id: "room-tool-7", toolName: "Read", summary: "x" },
  });
  expect(roomMsgToEvent({ from: "agent", type: "tool_result", summary: "ok", isError: false })).toEqual({
    type: "room_tool_result",
    summary: "ok",
    isError: false,
  });
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
