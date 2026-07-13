import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetWorkTree } from "./PetWorkTree";
import type { PetWorkMap } from "./petWorkMap";

const workMap: PetWorkMap = {
  counts: { unfinished: 1, optimization: 1, completed: 1 },
  itemIds: {
    unfinished: ["unfinished:one"],
    optimization: ["optimization:one"],
    completed: ["completed:one"],
  },
  dismissedCount: 2,
  hiddenCount: 2,
  unclassifiedCount: 7,
  groups: [
    {
      workspace: "codeshell",
      latestActivityAt: 3_000,
      unfinished: [
        {
          id: "unfinished:one",
          kind: "unfinished",
          state: "running",
          workspace: "codeshell",
          title: "修复 Pet 工作地图",
          detail: "正在运行测试",
          lastActivityAt: 3_000,
          navigation: { agentSessionId: "session-secret-one" },
        },
      ],
      optimization: [
        {
          id: "optimization:one",
          kind: "optimization",
          state: "optimization",
          workspace: "codeshell",
          title: "优化启动速度",
          lastActivityAt: 2_000,
          navigation: { agentSessionId: "session-secret-two" },
        },
      ],
      completed: [
        {
          id: "completed:one",
          kind: "completed",
          state: "completed",
          workspace: "codeshell",
          title: "完成宠物拖动",
          lastActivityAt: 1_000,
          navigation: { agentSessionId: "session-secret-three" },
        },
      ],
    },
  ],
};

describe("PetWorkTree", () => {
  test("keeps the work inbox drawer closed by default", () => {
    const html = renderToStaticMarkup(<PetWorkTree workMap={workMap} />);
    expect(html).toContain('data-pet-work-tree="workspace-work-map"');
    expect(html).toContain('data-pet-work-drawer="toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("工作收件箱");
    expect(html).toContain("3 项");
    expect(html).not.toContain('data-pet-work-drawer-content="open"');
    expect(html).not.toContain("codeshell");
  });

  test("renders a bounded workspace work tree instead of a raw session list when opened", () => {
    const html = renderToStaticMarkup(
      <PetWorkTree
        workMap={workMap}
        defaultOpen
        onDismiss={() => {}}
        onClearCompleted={() => {}}
        onRestoreDismissed={() => {}}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-pet-work-drawer-content="open"');
    expect(html).toContain("codeshell");
    expect(html).toContain("未完成");
    expect(html).toContain("可优化");
    expect(html).toContain("最近完成");
    expect(html).toContain("清除已完成");
    expect(html).toContain("恢复隐藏项（2）");
    expect(html).toContain('data-pet-work-dismiss="unfinished:one"');
    expect(html).toContain("7 条旧记录没有明确结论，已收起");
    expect(html).toContain("另有 2 项较早记录未展开");
    expect(html).not.toContain("工作会话");
    expect(html).not.toContain("session-secret");
  });
});
