import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { captureScrollAnchor, MessageStream, restoreScrollAnchor } from "./MessageStream";
import { initialChatState, type ChatState, type ChatItem } from "@/lib/streamReducer";

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
        {
          kind: "tool",
          id: "t1",
          name: "Read",
          args: { file_path: "x" },
          done: true,
          result: "ok",
        },
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
    <MessageStream
      chat={withItems([{ kind: "assistant", id: "a1", text: "Hel", reasoning: "", done: false }])}
    />,
  );
  expect(html).toContain("Hel");
  expect(html).toContain("▋");
});

// Completed assistant prose renders as Markdown (lists/code/bold), not raw text.
// This is the CC-session "原始 Markdown 文本" fix — a done bubble must produce
// real elements, while a still-streaming bubble stays plain text to avoid
// re-parsing half-formed markdown on every token.
test("完成的 assistant 渲染 Markdown 结构", () => {
  const md = "# 标题\n\n- 一项\n- 二项\n\n`code` 和 **粗体**";
  const html = renderToStaticMarkup(
    <MessageStream
      chat={withItems([{ kind: "assistant", id: "a1", text: md, reasoning: "", done: true }])}
    />,
  );
  // Heading, list, inline code, bold → real tags, not the literal markdown chars.
  expect(html).toContain("<h1");
  expect(html).toContain("<ul");
  expect(html).toContain("<li");
  expect(html).toContain("<code");
  expect(html).toContain("<strong");
  expect(html).not.toContain("# 标题");
});

test("assistant 宽内容气泡可收缩,代码块和表格保留内部横向滚动", () => {
  const md =
    "https://example.com/" +
    "very-long-unbroken-path-segment-".repeat(20) +
    "\n\n```ts\n" +
    "const veryLongLine = '" +
    "x".repeat(220) +
    "';\n```\n\n| " +
    Array.from({ length: 8 }, (_, i) => `列${i}`).join(" | ") +
    " |\n| " +
    Array.from({ length: 8 }, () => "---").join(" | ") +
    " |\n| " +
    Array.from({ length: 8 }, (_, i) => `内容${i}`).join(" | ") +
    " |";
  const html = renderToStaticMarkup(
    <MessageStream
      chat={withItems([{ kind: "assistant", id: "a1", text: md, reasoning: "", done: true }])}
    />,
  );

  expect(html).toContain("flex min-w-0 justify-start gap-2");
  expect(html).toContain("mobile-message-assistant min-w-0 max-w-[92%]");
  expect(html).toContain("min-w-0 break-words");
  expect(html).toContain("min-w-0 max-w-full text-[15px]");
  expect(html).toContain("overflow-x-auto");
});

test("流式中的 Markdown 仍按纯文本显示(避免抖动)", () => {
  const md = "# 还在打字";
  const html = renderToStaticMarkup(
    <MessageStream
      chat={withItems([{ kind: "assistant", id: "a1", text: md, reasoning: "", done: false }])}
    />,
  );
  // While streaming we keep the raw text (+ cursor), no heading parsing.
  expect(html).toContain("# 还在打字");
  expect(html).not.toContain("<h1");
  expect(html).toContain("▋");
});

test("有 reasoning 时给出显示思考入口", () => {
  const html = renderToStaticMarkup(
    <MessageStream
      chat={withItems([{ kind: "assistant", id: "a1", text: "答", reasoning: "想法", done: true }])}
    />,
  );
  expect(html).toContain("显示思考");
});

test("滚动锚点: 用户不在底部时 append 后保持阅读位置", () => {
  const anchor = captureScrollAnchor({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 });
  expect(anchor.stickToBottom).toBe(false);
  expect(restoreScrollAnchor({ scrollTop: 0, scrollHeight: 1300, clientHeight: 400 }, anchor)).toBe(
    600,
  );
});

test("滚动锚点: 原本贴底时 append 后继续贴底", () => {
  const anchor = captureScrollAnchor({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 });
  expect(anchor.stickToBottom).toBe(true);
  expect(restoreScrollAnchor({ scrollTop: 0, scrollHeight: 1300, clientHeight: 400 }, anchor)).toBe(
    900,
  );
});
