import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CcPermissionModeSheet } from "./CcPermissionModeSheet";

// The picker mirrors the desktop "选择权限模式" dialog: three modes, with
// bypassPermissions flagged as the dangerous one. (Interactive selection isn't
// exercised here — the mobile test setup is static renderToStaticMarkup only —
// but the rendered surface and danger styling are.)
test("CcPermissionModeSheet 列出三档权限模式 + 危险标记", () => {
  const html = renderToStaticMarkup(
    <CcPermissionModeSheet sessionLabel="看一下仓库" onPick={() => {}} onCancel={() => {}} />,
  );
  expect(html).toContain("选择权限模式");
  expect(html).toContain("看一下仓库"); // the session label
  expect(html).toContain("默认");
  expect(html).toContain("自动改");
  expect(html).toContain("全放行");
  // bypassPermissions is styled with the error color.
  expect(html).toContain("text-status-err");
  expect(html).toContain("取消");
});
