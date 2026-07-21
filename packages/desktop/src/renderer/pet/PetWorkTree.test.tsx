import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetWorkTree } from "./PetWorkTree";
import type { PetWorkMap } from "./petWorkMap";

const workMap: PetWorkMap = {
  counts: { running: 1, pending: 0, "follow-up": 1, completed: 1, other: 1 },
  itemIds: {
    running: ["running:one"],
    pending: [],
    "follow-up": ["follow-up:one"],
    completed: ["completed:one"],
    other: ["other:one"],
  },
  dismissedCount: 2,
  hiddenCount: 2,
  unclassifiedCount: 0,
  groups: [
    {
      workspace: "codeshell",
      latestActivityAt: 3_000,
      buckets: [
        {
          group: "running",
          items: [
            {
              id: "running:one",
              group: "running",
              state: "running",
              workspace: "codeshell",
              title: "修复 Pet 工作地图",
              detail: "正在运行测试",
              lastActivityAt: 3_000,
              navigation: { agentSessionId: "session-secret-one" },
            },
          ],
        },
        {
          group: "follow-up",
          items: [
            {
              id: "follow-up:one",
              group: "follow-up",
              state: "follow-up",
              workspace: "codeshell",
              title: "跟进启动速度",
              lastActivityAt: 2_000,
              navigation: { agentSessionId: "session-secret-two" },
            },
          ],
        },
        {
          group: "completed",
          items: [
            {
              id: "completed:one",
              group: "completed",
              state: "completed",
              workspace: "codeshell",
              title: "完成宠物拖动",
              lastActivityAt: 1_000,
              navigation: { agentSessionId: "session-secret-three" },
            },
          ],
        },
        {
          group: "other",
          items: [
            {
              id: "other:one",
              group: "other",
              state: "idle",
              workspace: "codeshell",
              title: "普通历史工作",
              lastActivityAt: 900,
              navigation: { agentSessionId: "session-secret-four" },
            },
          ],
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
    expect(html).toContain("4 项");
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
    expect(html).toContain("进行中");
    expect(html).toContain("待跟进");
    expect(html).toContain("已完成");
    expect(html).toContain("其他");
    expect(html).toContain("清除已完成");
    expect(html).toContain("恢复隐藏项（2）");
    expect(html).toContain('data-pet-work-dismiss="running:one"');
    expect(html).toContain("另有 2 项较早记录未展开");
    expect(html).not.toContain("工作会话");
    expect(html).not.toContain("session-secret");
  });
});

test("renders external-CLI and risk badges on items that carry them", () => {
  const badgeMap: PetWorkMap = {
    groups: [
      {
        workspace: "codeshell",
        latestActivityAt: 5_000,
        buckets: [
          {
            group: "running" as const,
            items: [
              {
                id: "running:ext",
                group: "running" as const,
                state: "running" as const,
                workspace: "codeshell",
                title: "外部会话",
                lastActivityAt: 5_000,
                external: { cli: "codex" as const },
                navigation: { agentSessionId: "ext" },
              },
            ],
          },
          {
            group: "pending" as const,
            items: [
              {
                id: "pending:risk:r1",
                group: "pending" as const,
                state: "needs-action" as const,
                workspace: "codeshell",
                title: "待决策",
                lastActivityAt: 4_000,
                risk: { level: "high" as const, toolName: "Bash" },
                navigation: { agentSessionId: "risk", requestId: "r1" },
              },
            ],
          },
          {
            group: "other" as const,
            items: [
              {
                id: "other:plain",
                group: "other" as const,
                state: "idle" as const,
                workspace: "codeshell",
                title: "普通会话",
                lastActivityAt: 900,
                navigation: { agentSessionId: "plain" },
              },
            ],
          },
        ],
      },
    ],
    counts: { running: 1, pending: 1, "follow-up": 0, completed: 0, other: 1 },
    itemIds: {
      running: ["running:ext"],
      pending: ["pending:risk:r1"],
      "follow-up": [],
      completed: [],
      other: ["other:plain"],
    },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={badgeMap} defaultOpen />);
  expect(html).toContain("codex");
  expect(html).toContain("高风险");
  expect(html).toContain("Bash");
  // The plain "other" item must not sprout a risk/external badge.
  expect(html).not.toContain("claude");
});

test.each([
  ["medium" as const, "中风险", "bg-status-warn/15 text-status-warn"],
  ["low" as const, "低风险", "bg-muted text-muted-foreground"],
])("renders the %s risk badge with its tone class", (level, label, tone) => {
  const riskMap: PetWorkMap = {
    groups: [
      {
        workspace: "codeshell",
        latestActivityAt: 4_000,
        buckets: [
          {
            group: "pending" as const,
            items: [
              {
                id: "pending:risk:r1",
                group: "pending" as const,
                state: "needs-action" as const,
                workspace: "codeshell",
                title: "待决策",
                lastActivityAt: 4_000,
                risk: { level, toolName: "Write" },
                navigation: { agentSessionId: "risk", requestId: "r1" },
              },
            ],
          },
        ],
      },
    ],
    counts: { running: 0, pending: 1, "follow-up": 0, completed: 0, other: 0 },
    itemIds: {
      running: [],
      pending: ["pending:risk:r1"],
      "follow-up": [],
      completed: [],
      other: [],
    },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={riskMap} defaultOpen />);
  expect(html).toContain(label);
  expect(html).toContain(tone);
  expect(html).toContain("Write");
});

test("renders the other bucket and its i18n label without hiding items", () => {
  const otherOnly: PetWorkMap = {
    groups: [
      {
        workspace: "alpha",
        buckets: [
          {
            group: "other" as const,
            items: [
              {
                id: "other:x",
                group: "other" as const,
                state: "idle" as const,
                workspace: "alpha",
                title: "闲置会话",
                lastActivityAt: 1,
                navigation: { agentSessionId: "x" },
              },
            ],
          },
        ],
        latestActivityAt: 1,
      },
    ],
    counts: { running: 0, pending: 0, "follow-up": 0, completed: 0, other: 1 },
    itemIds: { running: [], pending: [], "follow-up": [], completed: [], other: ["other:x"] },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={otherOnly} defaultOpen />);
  expect(html).toContain("闲置会话");
  expect(html).toContain("其他"); // pet.work.branch.other zh label
});
