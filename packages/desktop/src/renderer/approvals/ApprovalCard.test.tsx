import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard, computerUseWording, decidedLabel } from "./ApprovalCard";
import { translate } from "../i18n/translate";
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
  test("approve session/project → suffixed with the chosen option's label", () => {
    expect(decidedLabel({ kind: "approve", scope: "session", label: "本会话允许写 src/ 下" })).toBe(
      "已批准 · 本会话允许写 src/ 下",
    );
    // No label → falls back to the bare scope name.
    expect(decidedLabel({ kind: "approve", scope: "project" })).toBe("已批准 · project");
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

  test("renders a human-readable ReadSource summary and keeps raw args available", () => {
    const envelope = {
      ...ENV,
      request: {
        toolName: "ReadSource",
        args: { source: "team-docs", scope: "handbook", resource: "onboarding.md" },
        description: "Read a bound source",
        riskLevel: "medium",
      },
    } as ApprovalRequestEnvelope;

    const html = renderToStaticMarkup(<ApprovalCard envelope={envelope} onDecide={() => {}} />);

    expect(html).toContain("读取数据源 team-docs · 范围 handbook · 资源 onboarding.md");
    expect(html).toContain("展开原始参数");
  });
});

describe("computer-use approvals of an external runtime", () => {
  const request = (computerUse: unknown) =>
    ({
      toolName: "Computer use: click",
      args: { pid: 412, window_id: 7, element_index: 3 },
      description: "Claude Code 想操控电脑：click（pid 412, window 7）",
      riskLevel: "high",
      computerUse,
    }) as unknown as ApprovalRequestEnvelope["request"];
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate("zh", key, params);
  const en = (key: string, params?: Record<string, string | number>) =>
    translate("en", key, params);

  test("the card says what is about to be controlled, in the user's language", () => {
    const click = request({ runtime: "claude-code", action: "click", pid: 412, windowId: 7 });
    expect(computerUseWording(click, zh)).toEqual({
      title: "电脑操控 · 点击",
      description: "Claude Code 想操控你的电脑：点击（进程 412 的窗口 7）",
    });
    expect(computerUseWording(click, en)).toEqual({
      title: "Computer use · click",
      description: "Claude Code wants to control your computer: click (window 7 of process 412)",
    });
    const html = renderToStaticMarkup(
      <ApprovalCard
        envelope={{ sessionId: "s1", requestId: "r2", request: click } as ApprovalRequestEnvelope}
        onDecide={() => {}}
      />,
    );
    expect(html).toContain("电脑操控 · 点击");
    expect(html).not.toContain("native");
  });

  test("an app name outranks a process id; Codex carries only the action", () => {
    expect(
      computerUseWording(
        request({ runtime: "claude-code", action: "launch_app", app: "Notes", pid: 1 }),
        en,
      )?.description,
    ).toBe("Claude Code wants to control your computer: open an app (app Notes)");
    expect(computerUseWording(request({ runtime: "codex", action: "type_text" }), zh)).toEqual({
      title: "电脑操控 · 输入文字",
      description: "Codex 想操控你的电脑：输入文字",
    });
  });

  test("an action without a translation keeps the driver's name; anything malformed is ignored", () => {
    expect(
      computerUseWording(request({ runtime: "codex", action: "brand_new_tool" }), en)?.title,
    ).toBe("Computer use · brand_new_tool");
    expect(computerUseWording(request(undefined), zh)).toBeUndefined();
    expect(computerUseWording(request({ runtime: "other", action: "click" }), zh)).toBeUndefined();
    expect(
      computerUseWording(request({ runtime: "codex", action: "<b>click</b>" }), zh),
    ).toBeUndefined();
  });
});
