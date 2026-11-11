import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialsPage } from "./CredentialsPage";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastProvider } from "../ui/ToastProvider";

describe("CredentialsPage", () => {
  test("renders four top-level categories and the Cookie tab by default", () => {
    // renderToStaticMarkup runs no effects (no IPC), so window.codeshell is not
    // touched during the initial render — the default tab is "cookie". The
    // Cookie tab uses useConfirm/useToast, so wrap in their providers.
    const html = renderToStaticMarkup(
      <ToastProvider>
        <DialogProvider>
          <CredentialsPage activeProjectPath={null} />
        </DialogProvider>
      </ToastProvider>,
    );
    expect(html).toContain("网站登录");
    expect(html).toContain("API 密钥");
    expect(html).toContain("Link");
    expect(html).toContain("沟通渠道");
    // Cookie tab's login form proves it's the default-rendered tab.
    expect(html).toContain("弹窗登录并保存");
    // 全局「AI 取用免审批」总开关已删(改逐条 autoUseByAI/autoInjectByAI 卡片开关)。
  });

  test("the 沟通渠道 tab points to Mimi settings › 消息连接 instead of binding here", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <DialogProvider>
          <CredentialsPage
            activeProjectPath={null}
            initialTab="channels"
            onOpenMimiConnections={() => undefined}
          />
        </DialogProvider>
      </ToastProvider>,
    );
    expect(html).toContain("data-channels-moved");
    expect(html).toContain("data-open-mimi-connections");
    expect(html).toContain("消息渠道在 Mimi 设置里绑定");
    expect(html).toContain("打开消息连接");
    // The gateway controls themselves are gone from this page.
    expect(html).not.toContain("CodeShell Chat Gateway");
    // The other categories are untouched.
    expect(html).toContain("网站登录");
    expect(html).toContain("API 密钥");
  });
});
