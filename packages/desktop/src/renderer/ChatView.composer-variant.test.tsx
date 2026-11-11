import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// AppQuickChat.test.tsx installs a module mock for its integration harness.
// The query suffix keeps this focused render test on the real component even
// when Bun schedules both files in one worker.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView } = await import("./ChatView.tsx?composer-variant-render-test");

function renderComposer(
  variant: "main" | "quickChat" | "pet",
  permissionMode = "plan",
  messages: unknown[] = [],
  historyProps: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    <ChatView
      variant={variant}
      messages={messages as never}
      onSend={() => undefined}
      onStop={() => undefined}
      busy={false}
      activeProjectId={null}
      permissionMode={permissionMode}
      onPermissionChange={() => undefined}
      goalEnabled={false}
      onGoalToggle={() => undefined}
      modelOptions={[
        {
          key: `${variant}-model`,
          label: variant === "main" ? "Main Model" : "Side Model",
          provider: "test",
          maxContextTokens: 100_000,
          supportsVision: true,
        },
      ]}
      activeModelKey={`${variant}-model`}
      onModelChange={() => undefined}
      contextTokens={1_000}
      contextMax={100_000}
      projects={[]}
      onSelectProject={() => undefined}
      onAddProject={() => undefined}
      configurationTarget={{ noRepo: true }}
      configurationAvailable={false}
      conversationRoot={null}
      conversationRootId={null}
      draft=""
      onDraftChange={() => undefined}
      attachments={[]}
      onAttachmentsChange={() => undefined}
      {...historyProps}
    />,
  );
}

describe("ChatView composer variants", () => {
  test("keeps goal and context usage in the main composer", () => {
    const html = renderComposer("main", "default");

    expect(html).toContain(">Goal<");
    expect(html).toContain(">1%<");
    expect(html).toContain('data-composer-control="context-usage"');
    expect(html).toContain("当前模型：Main Model");
    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain('data-theme-surface="chat"');
    expect(html).toContain('data-theme-surface="composer"');
  });

  test("keeps model, voice, attachment, and permission controls in quick chat", () => {
    const html = renderComposer("quickChat");

    expect(html).toContain("当前模型：Side Model");
    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain('aria-label="添加本地文件"');
    expect(html).toContain("当前对话权限：计划模式");
    expect(html).not.toContain(">Goal<");
    expect(html).not.toContain('data-composer-control="context-usage"');
    expect(html).not.toContain("data-theme-surface");
  });

  test("reflects an elevated quick-chat permission without adding durable controls", () => {
    const html = renderComposer("quickChat", "bypass");

    expect(html).toContain("当前对话权限：完全访问权限");
    expect(html).not.toContain(">Goal<");
    expect(html).not.toContain('data-composer-control="context-usage"');
  });

  test("keeps the shared chat language while hiding pet-unsafe affordances", () => {
    const html = renderComposer("pet", "bypass");

    expect(html).toContain('data-chat-variant="pet"');
    expect(html).toContain("当前模型：Side Model");
    expect(html).toContain('aria-label="语音输入"');
    expect(html).not.toContain("完全访问权限");
    expect(html).not.toContain('aria-label="添加本地文件"');
    expect(html).not.toContain(">Goal<");
    expect(html).not.toContain('data-composer-control="context-usage"');
  });
});

describe("ChatView history paging", () => {
  test("keeps the earlier-history action inside the conversation stream", () => {
    const html = renderComposer(
      "main",
      "default",
      [{ kind: "user", id: "recent", text: "Recent turn" }],
      {
        historyHasMore: true,
        onLoadEarlierHistory: async () => undefined,
      },
    );
    expect(html).toContain("加载更早记录");
    expect(html.indexOf("data-chat-history-control")).toBeLessThan(html.indexOf("Recent turn"));
  });

  test("shows retry after an initial history failure instead of a fresh-chat welcome", () => {
    const html = renderComposer("main", "default", [], {
      historyFailed: true,
      onLoadEarlierHistory: async () => undefined,
    });
    expect(html).toContain('data-mode="active"');
    expect(html).toContain("重试加载记录");
    expect(html).toContain("聊天记录暂时未能加载");
    expect(html).not.toContain("选择一个开始的方向");
  });

  test("disables an in-progress page request", () => {
    const html = renderComposer(
      "main",
      "default",
      [{ kind: "user", id: "recent", text: "Recent turn" }],
      {
        historyHasMore: true,
        historyLoading: true,
        onLoadEarlierHistory: async () => undefined,
      },
    );
    expect(html).toContain("正在加载更早记录");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?正在加载更早记录/);
  });
});

describe("ChatView embedded question region", () => {
  // Questions share the composer's centered column and stable container.
  const pendingAsk = {
    kind: "ask_user",
    id: "q1",
    requestId: "r1",
    question: "继续吗？",
    multiSelect: false,
    options: [{ label: "继续", description: "继续执行" }],
  };

  test("embeds the pending question inside the composer column", () => {
    const html = renderComposer("main", "default", [pendingAsk]);
    expect(html).toContain("继续吗？");
    expect(html).toContain("cs-chat-question-dock");
    expect(html.indexOf("cs-chat-composer-wrap")).toBeLessThan(
      html.indexOf("cs-chat-question-dock"),
    );
    expect(html).not.toContain("cs-chat-sticky");
  });

  // An answer-later question emitted mid-run used to render only inline, where
  // the turn's collapsed process card swallowed it. It now pins like any other.
  test("pins an unanswered asynchronous question above the composer", () => {
    const html = renderComposer("main", "default", [{ ...pendingAsk, asynchronous: true }]);
    expect(html).toContain("cs-chat-question-dock");
    expect(html.indexOf("cs-chat-question-dock")).toBeLessThan(html.indexOf("继续吗？"));
    expect(html).toContain("稍后回答");
    expect(html.split("继续吗？")).toHaveLength(2);
  });

  test("pins the blocking question first, then answer-later questions", () => {
    const html = renderComposer("main", "default", [
      { ...pendingAsk, id: "a1", requestId: "ra1", question: "稍后也行？", asynchronous: true },
      pendingAsk,
    ]);
    const sticky = html.slice(html.indexOf("cs-chat-question-dock"));
    expect(sticky.indexOf("继续吗？")).toBeGreaterThan(-1);
    expect(sticky.indexOf("继续吗？")).toBeLessThan(sticky.indexOf("稍后也行？"));
  });

  test("keeps an answered question in the stream, not the sticky area", () => {
    const html = renderComposer("main", "default", [{ ...pendingAsk, answer: "继续" }]);
    expect(html).not.toContain("cs-chat-question-dock");
  });
});
