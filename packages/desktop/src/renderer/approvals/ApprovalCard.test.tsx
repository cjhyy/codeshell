import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard, decidedLabel } from "./ApprovalCard";
import type { ApprovalRequestEnvelope } from "../../preload/types";

const ENV: ApprovalRequestEnvelope = {
  sessionId: "s1",
  requestId: "r1",
  request: {
    toolName: "Bash",
    args: { command: "git status" },
    description: "Run shell command",
    riskLevel: "medium",
  },
} as ApprovalRequestEnvelope;

describe("decidedLabel", () => {
  test("approve once → bare 已批准 (no scope suffix)", () => {
    expect(decidedLabel({ kind: "approve", scope: "once" })).toBe("已批准");
    expect(decidedLabel({ kind: "approve" })).toBe("已批准");
  });
  test("approve session/project → suffixed with the scope label", () => {
    expect(decidedLabel({ kind: "approve", scope: "session" })).toBe("已批准 · 本会话一直允许");
    expect(decidedLabel({ kind: "approve", scope: "project" })).toBe("已批准 · 本项目一直允许");
  });
  test("deny → 已拒绝", () => {
    expect(decidedLabel({ kind: "deny" })).toBe("已拒绝");
  });
});

describe("ApprovalCard render", () => {
  test("renders the approve control and the request summary before any decision", () => {
    const html = renderToStaticMarkup(<ApprovalCard envelope={ENV} onDecide={() => {}} />);
    expect(html).toContain("批准");
    expect(html).toContain("git status");
    expect(html).toContain("Bash");
    // The scope chooser affordance (split-button ▾) is present.
    expect(html).toContain("选择批准范围");
  });
});
