import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageStream } from "./MessageStream";
import { initialChatState, type ChatState, type ChatItem } from "@mobile/lib/streamReducer";

function withItems(items: ChatItem[]): ChatState {
  return { ...initialChatState(), items };
}

test("空态显示提示", () => {
  const html = renderToStaticMarkup(<MessageStream chat={initialChatState()} />);
  expect(html).toContain("发个任务试试");
});

test("渲染 user / assistant / tool / 子代理 / 错误", () => {
  const html = renderToStaticMarkup(
    <MessageStream
      chat={withItems([
        { kind: "user", id: "u1", text: "你好世界" },
        { kind: "assistant", id: "a1", text: "回答内容", reasoning: "", done: true },
        { kind: "tool", id: "t1", name: "Read", args: { file_path: "x" }, done: true, result: "ok" },
        { kind: "subagent", id: "s1", agentId: "A", label: "任务 1/2", status: "running" },
        { kind: "system_error", id: "e1", text: "炸了" },
      ])}
    />,
  );
  expect(html).toContain("你好世界");
  expect(html).toContain("回答内容");
  expect(html).toContain("Read");
  expect(html).toContain("子代理");
  expect(html).toContain("炸了");
});

test("流式 assistant 显示光标", () => {
  const html = renderToStaticMarkup(
    <MessageStream chat={withItems([{ kind: "assistant", id: "a1", text: "Hel", reasoning: "", done: false }])} />,
  );
  expect(html).toContain("Hel");
  expect(html).toContain("▋");
});

test("有 reasoning 时给出显示思考入口", () => {
  const html = renderToStaticMarkup(
    <MessageStream chat={withItems([{ kind: "assistant", id: "a1", text: "答", reasoning: "想法", done: true }])} />,
  );
  expect(html).toContain("显示思考");
});
