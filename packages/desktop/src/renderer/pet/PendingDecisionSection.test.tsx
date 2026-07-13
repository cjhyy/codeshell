import { describe, expect, test } from "bun:test";
import type { PendingDecisionProjection } from "@cjhyy/code-shell-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingDecisionSection } from "./PendingDecisionSection";

const pending: PendingDecisionProjection = {
  owner: "local-user",
  agentSessionId: "agent-12345678",
  coreSessionId: "core-secret",
  requestId: "request-secret",
  workerGeneration: 2,
  kind: "tool_approval",
  title: "Bash needs a decision",
  toolName: "Bash",
  riskLevel: "high",
  createdAt: 1_000,
  status: "pending",
};

describe("PendingDecisionSection", () => {
  test("renders navigation-only pending rows without decision controls or sensitive ids", () => {
    const html = renderToStaticMarkup(<PendingDecisionSection pending={[pending]} />);
    expect(html).toContain("待你决定");
    expect(html).toContain("Bash needs a decision");
    expect(html).toContain("high risk");
    expect(html).toContain("打开并处理");
    expect(html).not.toContain("批准");
    expect(html).not.toContain("拒绝");
    expect(html).not.toContain("core-secret");
    expect(html).not.toContain("request-secret");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("input");
  });

  test("renders a dedicated no-pending state", () => {
    expect(renderToStaticMarkup(<PendingDecisionSection pending={[]} />)).toContain(
      "没有待处理决策",
    );
  });
});
