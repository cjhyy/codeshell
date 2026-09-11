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
  });

  test("keeps model, voice, attachment, and permission controls in quick chat", () => {
    const html = renderComposer("quickChat");

    expect(html).toContain("当前模型：Side Model");
    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain('aria-label="添加本地文件"');
    expect(html).toContain("当前对话权限：计划模式");
    expect(html).not.toContain(">Goal<");
    expect(html).not.toContain('data-composer-control="context-usage"');
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

describe("ChatView sticky ask column", () => {
  // The sticky ask/approval region renders outside .cs-chat-transcript, so it
  // does not inherit that element's centered 48rem column. Without its own
  // column class it stretched the full viewport while the messages above it
  // stayed centered, so the ask card sat flush against the left edge.
  const pendingAsk = {
    kind: "ask_user",
    id: "q1",
    requestId: "r1",
    question: "继续吗？",
    multiSelect: false,
    options: [{ label: "继续", description: "继续执行" }],
  };

  test("wraps the pending ask in the shared transcript column", () => {
    const html = renderComposer("main", "default", [pendingAsk]);
    expect(html).toContain("继续吗？");
    expect(html).toContain("cs-chat-sticky");
  });
});
