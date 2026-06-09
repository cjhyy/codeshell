import { test, expect } from "bun:test";
import {
  reduceStream,
  initialChatState,
  appendUserMessage,
  type ChatItem,
} from "./streamReducer";

/** Wrap an inner StreamEvent into the agent/streamEvent JSON-RPC envelope. */
function ev(event: Record<string, unknown>, sessionId?: string) {
  return { method: "agent/streamEvent", params: { event, sessionId } };
}

function feed(events: unknown[]) {
  return events.reduce(reduceStream, initialChatState());
}

const tool = (s: ReturnType<typeof feed>) =>
  s.items.find((i) => i.kind === "tool") as Extract<ChatItem, { kind: "tool" }>;
const asst = (s: ReturnType<typeof feed>) =>
  s.items.find((i) => i.kind === "assistant") as Extract<ChatItem, { kind: "assistant" }>;

test("text_delta 合并到同一条 assistant", () => {
  const s = feed([
    ev({ type: "stream_request_start", turnNumber: 1 }),
    ev({ type: "text_delta", text: "你" }),
    ev({ type: "text_delta", text: "好" }),
  ]);
  expect(asst(s).text).toBe("你好");
  expect(s.run).toBe("running");
});

test("text_delta 在没有 stream_request_start 时自开一条", () => {
  const s = feed([ev({ type: "text_delta", text: "hi" })]);
  expect(asst(s).text).toBe("hi");
});

test("thinking_delta 累计到 reasoning", () => {
  const s = feed([
    ev({ type: "stream_request_start", turnNumber: 1 }),
    ev({ type: "thinking_delta", text: "想…" }),
    ev({ type: "text_delta", text: "答案" }),
  ]);
  expect(asst(s).reasoning).toBe("想…");
  expect(asst(s).text).toBe("答案");
});

test("tool_use_start + tool_result 配对", () => {
  const s = feed([
    ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: { file_path: "x" } } }),
    ev({ type: "tool_result", result: { id: "t1", result: "ok" } }),
  ]);
  expect(tool(s).name).toBe("Read");
  expect(tool(s).done).toBe(true);
  expect(tool(s).result).toBe("ok");
  expect(tool(s).error).toBe(false);
});

test("tool_result 带 isError → error 标记", () => {
  const s = feed([
    ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } }),
    ev({ type: "tool_result", result: { id: "t1", error: "boom", isError: true } }),
  ]);
  expect(tool(s).error).toBe(true);
  expect(tool(s).result).toBe("boom");
});

test("重复 tool_use_start 幂等", () => {
  const s = feed([
    ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: {} } }),
    ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: {} } }),
  ]);
  expect(s.items.filter((i) => i.kind === "tool")).toHaveLength(1);
});

test("tool_summary 挂到最后一个 tool", () => {
  const s = feed([
    ev({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: {} } }),
    ev({ type: "tool_summary", summary: "读了 package.json" }),
  ]);
  expect(tool(s).summary).toBe("读了 package.json");
});

test("turn_complete completed → run completed,封口 assistant", () => {
  const s = feed([
    ev({ type: "stream_request_start", turnNumber: 1 }),
    ev({ type: "text_delta", text: "x" }),
    ev({ type: "turn_complete", reason: "completed" }),
  ]);
  expect(s.run).toBe("completed");
  expect(asst(s).done).toBe(true);
  expect(s.liveAssistantId).toBeUndefined();
});

test("turn_complete aborted → run idle(不算 error)", () => {
  const s = feed([ev({ type: "turn_complete", reason: "aborted_streaming" })]);
  expect(s.run).toBe("idle");
});

test("turn_complete model_error → run error", () => {
  const s = feed([ev({ type: "turn_complete", reason: "model_error" })]);
  expect(s.run).toBe("error");
});

test("goal_progress 更新 goal 行", () => {
  const s = feed([ev({ type: "goal_progress", status: "not_met", round: 2 })]);
  expect(s.goal).toContain("第 2 轮");
  expect(s.goal).toContain("not_met");
});

test("agent_start/agent_end 维护单条 subagent 行(按 agentId)", () => {
  const s = feed([
    ev({ type: "agent_start", agentId: "sub-A", description: "查代码" }),
    ev({ type: "agent_start", agentId: "sub-A", description: "查代码" }),
    ev({ type: "agent_end", agentId: "sub-A" }),
  ]);
  const subs = s.items.filter((i) => i.kind === "subagent");
  expect(subs).toHaveLength(1);
  expect((subs[0] as Extract<ChatItem, { kind: "subagent" }>).status).toBe("completed");
});

test("task_update 按 agentId 隔离,不新增重复行", () => {
  const s = feed([
    ev({ type: "task_update", agentId: "sub-A", tasks: [{ status: "pending" }, { status: "completed" }] }),
    ev({ type: "task_update", agentId: "sub-A", tasks: [{ status: "completed" }, { status: "completed" }] }),
  ]);
  const subs = s.items.filter((i) => i.kind === "subagent");
  expect(subs).toHaveLength(1);
  expect((subs[0] as Extract<ChatItem, { kind: "subagent" }>).label).toBe("任务 2/2");
});

test("error 事件追加系统错误并置 run error", () => {
  const s = feed([ev({ type: "error", error: "炸了" })]);
  expect(s.run).toBe("error");
  const e = s.items.find((i) => i.kind === "system_error") as Extract<ChatItem, { kind: "system_error" }>;
  expect(e.text).toBe("炸了");
});

test("sessionId 从 envelope 带入", () => {
  const s = feed([ev({ type: "text_delta", text: "x" }, "sess-9")]);
  expect(s.sessionId).toBe("sess-9");
});

test("session_title 更新标题", () => {
  const s = feed([ev({ type: "session_title", sessionId: "s", title: "重构手机 UI" })]);
  expect(s.title).toBe("重构手机 UI");
});

test("bare event(history 回放)也被消费", () => {
  const s = feed([{ type: "text_delta", text: "回放" }]);
  expect(asst(s).text).toBe("回放");
});

test("appendUserMessage 追加用户气泡", () => {
  const s = appendUserMessage(initialChatState(), "hello");
  expect(s.items).toHaveLength(1);
  expect(s.items[0]).toMatchObject({ kind: "user", text: "hello" });
});

test("user_message(history 回放)重建用户气泡", () => {
  const s = feed([{ type: "user_message", text: "之前问的" }]);
  expect(s.items[0]).toMatchObject({ kind: "user", text: "之前问的" });
});

test("完整 history 回放重建一轮对话", () => {
  // 模拟 transcript 投影出的事件序列(user → stream_request_start → text →
  // tool start/result → turn_complete)。
  const s = feed([
    { type: "user_message", text: "看看仓库" },
    { type: "stream_request_start", turnNumber: 1 },
    { type: "text_delta", text: "好的" },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: { file_path: "package.json" } } },
    { type: "tool_result", result: { id: "t1", result: "{...}" } },
    { type: "turn_complete", reason: "completed" },
  ]);
  expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
  expect(s.run).toBe("completed");
  expect((s.items[1] as Extract<ChatItem, { kind: "assistant" }>).text).toBe("好的");
  expect((s.items[2] as Extract<ChatItem, { kind: "tool" }>).done).toBe(true);
});

test("ids 确定性(不依赖 Date.now/random)", () => {
  const a = feed([ev({ type: "error", error: "e" }), ev({ type: "error", error: "e" })]);
  const b = feed([ev({ type: "error", error: "e" }), ev({ type: "error", error: "e" })]);
  expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
});
