import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// AppQuickChat.test.tsx installs a module mock for its integration harness.
// The query suffix keeps this focused render test on the real component even
// when Bun schedules both files in one worker.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView } = await import("./ChatView.tsx?composer-variant-render-test");

function renderComposer(variant: "main" | "quickChat", permissionMode = "plan") {
  return renderToStaticMarkup(
    <ChatView
      variant={variant}
      messages={[]}
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
      activeProjectPath={null}
      draft=""
      onDraftChange={() => undefined}
      attachments={[]}
      onAttachmentsChange={() => undefined}
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
    expect(html).toContain('aria-label="添加图片"');
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
});
