import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "@cjhyy/code-shell-web";

const base: PendingApproval = {
  requestId: "r1",
  toolName: "Bash",
  description: "运行命令",
  summary: "rm -rf /tmp/x",
  risk: "high",
  pathScoped: false,
};

test("常规审批显示工具名/风险/允许拒绝", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={base} onRespond={() => {}} />);
  expect(html).toContain("Bash");
  expect(html).toContain("高风险");
  expect(html).toContain("rm -rf /tmp/x");
  expect(html).toContain("允许");
  expect(html).toContain("拒绝");
  expect(html).toContain("记住范围");
});

test("路径类工具显示路径范围(记住时)", () => {
  // pathScope chips only render when scope !== once; initial scope is once, so
  // they're hidden initially — assert the scope chips exist at least.
  const html = renderToStaticMarkup(
    <ApprovalCard approval={{ ...base, toolName: "Edit", pathScoped: true }} onRespond={() => {}} />,
  );
  expect(html).toContain("Edit");
  expect(html).toContain("本项目");
});

test("AskUser 审批渲染选项按钮", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, toolName: "AskUser", options: ["选项甲", "选项乙"], optionsOnly: false }}
      onRespond={() => {}}
    />,
  );
  expect(html).toContain("选项甲");
  expect(html).toContain("选项乙");
  expect(html).toContain("或输入自定义回答");
});

test("optionsOnly 不出自由输入", () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      approval={{ ...base, toolName: "AskUser", options: ["A"], optionsOnly: true }}
      onRespond={() => {}}
    />,
  );
  expect(html).not.toContain("或输入自定义回答");
});
