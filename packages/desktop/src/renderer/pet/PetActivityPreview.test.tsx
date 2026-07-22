import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetActivityPreview } from "./PetActivityPreview";

describe("PetActivityPreview", () => {
  test("renders Codex-style Session content in the requested activity stack", () => {
    const html = renderToStaticMarkup(
      <PetActivityPreview
        item={{
          key: "working:session-one",
          agentSessionId: "session-one",
          title: "修复登录流程",
          detail: "正在检查认证状态和回调处理",
          kind: "working",
          lastActivityAt: 100,
        }}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('data-pet-activity-preview="true"');
    expect(html).toContain("修复登录流程");
    expect(html).toContain("正在检查认证状态和回调处理");
    expect(html).toContain("animate-spin");
    expect(html).toContain("group-hover:[animation-play-state:paused]");
    expect(html).toContain("relative");
    expect(html).toContain("w-full");
    expect(html).not.toContain("shadow-2xl");
  });

  test("gives every activity state a hover dismissal control", () => {
    const completed = renderToStaticMarkup(
      <PetActivityPreview
        item={{
          key: "completed:session-one:100",
          agentSessionId: "session-one",
          title: "修复完成",
          kind: "completed",
          lastActivityAt: 100,
        }}
        onOpen={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    const working = renderToStaticMarkup(
      <PetActivityPreview
        item={{
          key: "working:session-two",
          agentSessionId: "session-two",
          title: "仍在执行",
          kind: "working",
          lastActivityAt: 100,
        }}
        onOpen={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(completed).toContain('data-pet-activity-dismiss="completed:session-one:100"');
    expect(completed).toContain("group-hover:opacity-100");
    expect(completed).toContain("关闭提醒：修复完成");
    expect(working).toContain('data-pet-activity-dismiss="working:session-two"');
    expect(working).toContain("收起 Session 动态：仍在执行");
  });

  test("disables a stale external card that has no complete locator", () => {
    const html = renderToStaticMarkup(
      <PetActivityPreview
        item={{
          key: "working:external",
          agentSessionId: "external",
          title: "外部工作",
          kind: "working",
          lastActivityAt: 100,
          external: { cli: "codex" },
        }}
        onOpen={() => undefined}
      />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("外部会话定位信息不完整或 transcript 已不存在，无法打开");
  });
});
