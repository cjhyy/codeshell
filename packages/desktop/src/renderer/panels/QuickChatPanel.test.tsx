import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// AppQuickChat.test.tsx installs a module mock for its integration harness.
// A query-suffixed import gives this focused render test the real component
// even when Bun runs both files in the same worker.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { QuickChatPanel } = await import("./QuickChatPanel.tsx?restricted-mode-render-test");

function render(permissionMode: "plan" | "bypass") {
  return renderToStaticMarkup(
    <QuickChatPanel
      sessionId="qchat-ui-test"
      messages={[]}
      busy={false}
      creationStatus="ready"
      contextMode="blank"
      draft=""
      permissionMode={permissionMode}
      onPermissionChange={() => undefined}
      onDraftChange={() => undefined}
      onSend={() => undefined}
      onStop={() => undefined}
      onRetry={() => undefined}
      onUseBlank={() => undefined}
    />,
  );
}

describe("QuickChatPanel permission indicator", () => {
  test("renders the restricted mode badge from the real quick-chat permission state", () => {
    const html = render("plan");
    expect(html).toContain("当前对话权限：受限访问");
  });

  test("renders full access after the quick chat is explicitly elevated", () => {
    const html = render("bypass");
    expect(html).toContain("当前对话权限：完全访问权限");
  });
});
