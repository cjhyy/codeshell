import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the real wrapper. AppQuickChat.test may replace its ChatView child in
// a shared Bun worker, so assertions intentionally use the stable variant and
// control markers implemented by both the real child and that harness mock.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { QuickChatPanel } = await import("./QuickChatPanel.tsx?lifecycle-integration-test");
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { ChatView: RealChatView } = await import("../ChatView.tsx?quick-panel-real-child-test");

function render(permissionMode: "plan" | "bypass") {
  return renderToStaticMarkup(
    <QuickChatPanel
      chatComponent={RealChatView}
      sessionId="qchat-wrapper-test"
      creationNonce="generation-wrapper"
      messages={[]}
      busy={false}
      creationStatus="ready"
      contextMode="blank"
      cwd="/tmp/project"
      draft=""
      attachments={[]}
      permissionMode={permissionMode}
      modelOptions={[
        {
          key: "side-model",
          label: "Side Model",
          provider: "test",
          supportsVision: true,
        },
      ]}
      activeModelKey="side-model"
      onPermissionChange={() => undefined}
      onModelChange={() => undefined}
      onDraftChange={() => undefined}
      onAttachmentsChange={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      onRetry={() => undefined}
      onUseBlank={() => undefined}
    />,
  );
}

describe("QuickChatPanel real composer integration", () => {
  test("wires the quickChat variant through the real wrapper", () => {
    const html = render("plan");

    expect(html).toContain('data-chat-variant="quickChat"');
    expect(html).not.toContain('data-composer-control="goal"');
    expect(html).not.toContain('data-composer-control="context-usage"');
  });

  test("keeps the real restricted and elevated permission labels", () => {
    expect(render("plan")).toContain("当前对话权限：受限访问");
    expect(render("bypass")).toContain("当前对话权限：完全访问权限");
  });
});
