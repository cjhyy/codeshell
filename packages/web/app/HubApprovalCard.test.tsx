import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HubApprovalCard } from "./HubApprovalCard.js";
import type { ApprovalRequestPayload } from "./protocol.js";

function question(expiresAt?: number): ApprovalRequestPayload {
  return {
    requestId: "r1",
    sessionId: "s1",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    request: {
      toolName: "__ask_user__",
      args: {
        question: "允许写入？",
        options: [{ label: "允许本次" }, { label: "拒绝" }],
        optionsOnly: true,
      },
      description: "允许写入？",
    },
  };
}

function render(payload: ApprovalRequestPayload): string {
  return renderToStaticMarkup(
    <HubApprovalCard payload={payload} busy={false} connected onDecide={() => {}} />,
  );
}

describe("HubApprovalCard deadline", () => {
  test("an open question shows its remaining time and stays answerable", () => {
    const html = render(question(Date.now() + 125_000));
    expect(html).toMatch(/2:0\d 后未回答将自动跳过/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  test("a passed deadline locks every control", () => {
    const html = render(question(Date.now() - 1));
    expect(html).toContain("已超时，不能再回答");
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toMatch(/\sdisabled=""/);
  });

  test("tool approvals say they will be refused, and no deadline shows no countdown", () => {
    const tool = question(Date.now() + 60_000);
    tool.request = { toolName: "Write", args: { file_path: "/tmp/x" }, riskLevel: "medium" };
    expect(render(tool)).toMatch(/\d:\d\d 后未处理将自动拒绝/);
    expect(render(question())).not.toContain("自动");
  });
});
