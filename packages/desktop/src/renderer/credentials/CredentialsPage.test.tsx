import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialsPage } from "./CredentialsPage";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastProvider } from "../ui/ToastProvider";

describe("CredentialsPage", () => {
  test("renders three tab labels and the Cookie tab by default", () => {
    // renderToStaticMarkup runs no effects (no IPC), so window.codeshell is not
    // touched during the initial render — the default tab is "cookie". The
    // Cookie tab uses useConfirm/useToast, so wrap in their providers.
    const html = renderToStaticMarkup(
      <ToastProvider>
        <DialogProvider>
          <CredentialsPage activeRepoPath={null} />
        </DialogProvider>
      </ToastProvider>,
    );
    expect(html).toContain("Cookie");
    expect(html).toContain("Permission Token");
    expect(html).toContain("Link");
    // Cookie tab's capture form proves it's the default-rendered tab.
    expect(html).toContain("弹窗登录并保存");
    expect(html).toContain("AI 取用凭证免审批");
  });
});
