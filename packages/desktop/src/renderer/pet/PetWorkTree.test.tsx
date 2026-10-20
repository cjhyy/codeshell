import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetWorkTree } from "./PetWorkTree";
import { buildPetWorkMap } from "./petWorkMap";
import type { PetWorkMap } from "./petWorkMap";

const workMap: PetWorkMap = {
  counts: { running: 1, pending: 0, completed: 1, other: 1 },
  itemIds: {
    running: ["running:one"],
    pending: [],
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
  test("shows active work immediately while keeping finished branches folded", () => {
    const html = renderToStaticMarkup(<PetWorkTree workMap={workMap} />);
    expect(html).toContain('data-pet-work-tree="workspace-work-map"');
    expect(html).toContain('data-pet-work-drawer="toggle"');
    expect(html).toMatch(/data-pet-work-drawer="toggle"[^>]*aria-expanded="true"/);
    expect(html).toContain("工作收件箱");
    expect(html).toContain("3 项");
    expect(html).toContain('data-pet-work-drawer-content="open"');
    expect(html).toContain("codeshell");
    expect(html).toMatch(/<details open=""[^>]*data-pet-work-branch="running"/);
    expect(html).toMatch(/<details data-pet-work-branch="completed"/);
    expect(html).toContain('data-pet-work-search="true"');
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
    expect(html).not.toContain("待跟进");
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

function reactPropsOf(node: unknown): Record<string, any> {
  const element = node as Record<string, any>;
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  return key ? element[key] : {};
}

function elementsByProp(node: unknown, prop: string, value?: unknown): any[] {
  const current = node as { childNodes?: unknown[] };
  const props = reactPropsOf(current);
  const matches = props[prop] !== undefined && (value === undefined || props[prop] === value);
  return [
    ...(matches ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => elementsByProp(child, prop, value)),
  ];
}

test("keeps an explicit collapse across snapshot updates and reopens for a pending deep link", async () => {
  ensureMiniDom();
  const container = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  const render = async (defaultOpen = false): Promise<void> => {
    await act(async () => {
      root.render(<PetWorkTree workMap={{ ...workMap }} defaultOpen={defaultOpen} />);
      await flushMicrotasks();
    });
  };
  try {
    await render();
    const branch = elementsByProp(container, "data-pet-work-branch", "running")[0];
    expect(reactPropsOf(branch).open).toBe(true);
    await act(async () => {
      reactPropsOf(branch).onToggle({ currentTarget: { open: false } });
      await flushMicrotasks();
    });
    await render();
    expect(reactPropsOf(elementsByProp(container, "data-pet-work-branch", "running")[0]).open).toBe(
      false,
    );

    const drawer = elementsByProp(container, "data-pet-work-drawer")[0];
    await act(async () => {
      reactPropsOf(drawer).onClick();
      await flushMicrotasks();
    });
    await render();
    expect(reactPropsOf(drawer)["aria-expanded"]).toBe(false);
    await render(true);
    expect(reactPropsOf(drawer)["aria-expanded"]).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("combines title, workspace and localized-state search with status filters and reset", async () => {
  ensureMiniDom();
  const container = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  const itemIds = (): string[] =>
    elementsByProp(container, "data-pet-work-item").map(
      (node) => reactPropsOf(node)["data-pet-work-item"],
    );
  const search = async (value: string): Promise<void> => {
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).onChange({
        target: { value },
      });
      await flushMicrotasks();
    });
  };
  try {
    await act(async () => {
      root.render(<PetWorkTree workMap={workMap} />);
      await flushMicrotasks();
    });
    await search("CODESHELL");
    expect(itemIds()).toHaveLength(3);
    await search("已完成");
    expect(itemIds()).toEqual(["completed:one"]);
    expect(
      reactPropsOf(elementsByProp(container, "data-pet-work-branch", "completed")[0]).open,
    ).toBe(true);
    await search("正在运行测试");
    expect(itemIds()).toEqual(["running:one"]);
    await search("");
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-filter", "running")[0]).onClick();
      await flushMicrotasks();
    });
    expect(itemIds()).toEqual(["running:one"]);
    await search("完成宠物");
    expect(itemIds()).toEqual([]);
    expect(elementsByProp(container, "data-pet-work-no-matches")).toHaveLength(1);
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-reset")[0]).onClick();
      await flushMicrotasks();
    });
    expect(itemIds()).toHaveLength(3);
    expect(
      reactPropsOf(elementsByProp(container, "data-pet-work-filter", "all")[0])["aria-pressed"],
    ).toBe(true);
    expect(reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).value).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a pending focus request clears filters and reopens a collapsed decision branch", async () => {
  ensureMiniDom();
  const container = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  const pendingMap: PetWorkMap = {
    ...workMap,
    counts: { ...workMap.counts, pending: 1 },
    itemIds: { ...workMap.itemIds, pending: ["pending:decision"] },
    groups: [
      {
        ...workMap.groups[0],
        buckets: [
          ...workMap.groups[0].buckets,
          {
            group: "pending",
            items: [
              {
                id: "pending:decision",
                group: "pending",
                state: "needs-action",
                workspace: "codeshell",
                title: "确认发布",
                lastActivityAt: 4_000,
                navigation: { agentSessionId: "decision", requestId: "approval" },
              },
            ],
          },
        ],
      },
    ],
  };
  const render = async (focusPending: boolean): Promise<void> => {
    await act(async () => {
      root.render(<PetWorkTree workMap={{ ...pendingMap }} focusPending={focusPending} />);
      await flushMicrotasks();
    });
  };
  const pendingBranch = () => elementsByProp(container, "data-pet-work-branch", "pending")[0];
  try {
    await render(false);
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-filter", "pending")[0]).onClick();
      reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).onChange({
        target: { value: "codeshell" },
      });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(pendingBranch()).onToggle({ currentTarget: { open: false } });
      await flushMicrotasks();
    });
    await render(false);
    expect(reactPropsOf(pendingBranch()).open).toBe(false);
    expect(reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).value).toBe(
      "codeshell",
    );

    await render(true);
    expect(reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).value).toBe("");
    expect(
      reactPropsOf(elementsByProp(container, "data-pet-work-filter", "all")[0])["aria-pressed"],
    ).toBe(true);
    expect(reactPropsOf(pendingBranch()).open).toBe(true);
    await act(async () => {
      reactPropsOf(pendingBranch()).onToggle({ currentTarget: { open: false } });
      await flushMicrotasks();
    });
    await render(true);
    expect(reactPropsOf(pendingBranch()).open).toBe(false);
    await render(false);
    await render(true);
    expect(reactPropsOf(pendingBranch()).open).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("finds older work beyond normal display limits without expanding the unfiltered inbox", async () => {
  ensureMiniDom();
  const container = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  const map = buildPetWorkMap(
    Array.from({ length: 10 }, (_, index) => ({
      agentSessionId: `completed-${index}`,
      title: index === 0 ? "Earlier launch notes" : `Recent result ${index}`,
      workspaceDisplayName: "codeshell",
      runState: "terminal" as const,
      terminal: { status: "completed" as const, at: index },
      queueDepth: 0,
      lastActivityAt: index,
      pendingDecisionCount: 0,
      freshness: { source: "disk" as const, observedAt: 2_000, workerState: "reclaimed" as const },
    })),
    [],
  );
  try {
    await act(async () => {
      root.render(<PetWorkTree workMap={map} />);
      await flushMicrotasks();
    });
    expect(elementsByProp(container, "data-pet-work-item")).toHaveLength(8);
    expect(elementsByProp(container, "data-pet-work-item", "completed:completed-0")).toHaveLength(
      0,
    );
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).onChange({
        target: { value: "earlier launch" },
      });
      await flushMicrotasks();
    });
    expect(elementsByProp(container, "data-pet-work-item")).toHaveLength(1);
    expect(elementsByProp(container, "data-pet-work-item", "completed:completed-0")).toHaveLength(
      1,
    );
    await act(async () => {
      reactPropsOf(elementsByProp(container, "data-pet-work-search")[0]).onChange({
        target: { value: "" },
      });
      await flushMicrotasks();
    });
    expect(elementsByProp(container, "data-pet-work-item")).toHaveLength(8);
  } finally {
    await act(async () => root.unmount());
  }
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
                external: {
                  cli: "codex" as const,
                  cwd: "/tmp/project",
                },
                navigation: {
                  agentSessionId: "ext",
                  external: { cli: "codex", cwd: "/tmp/project", sessionId: "thread-ext" },
                },
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
    counts: { running: 1, pending: 1, completed: 0, other: 1 },
    itemIds: {
      running: ["running:ext"],
      pending: ["pending:risk:r1"],
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
  expect(html).toMatch(/<details open=""[^>]*data-pet-work-branch="pending"/);
  expect(html.indexOf('data-pet-work-branch="pending"')).toBeLessThan(
    html.indexOf('data-pet-work-branch="running"'),
  );
  // The plain "other" item must not sprout a risk/external badge.
  expect(html).not.toContain("claude");
});

test("gives non-external rows a latest-result expand affordance and external rows none", () => {
  const mixed: PetWorkMap = {
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
                external: { cli: "codex" as const, cwd: "/tmp/project" },
                navigation: {
                  agentSessionId: "ext",
                  external: { cli: "codex", cwd: "/tmp/project", sessionId: "thread-ext" },
                },
              },
              {
                id: "running:internal",
                group: "running" as const,
                state: "running" as const,
                workspace: "codeshell",
                title: "内部会话",
                lastActivityAt: 4_000,
                navigation: { agentSessionId: "internal" },
              },
            ],
          },
        ],
      },
    ],
    counts: { running: 2, pending: 0, completed: 0, other: 0 },
    itemIds: {
      running: ["running:ext", "running:internal"],
      pending: [],
      completed: [],
      other: [],
    },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={mixed} defaultOpen />);
  // NOTE: renderToStaticMarkup cannot exercise the click → IPC → loading/error
  // states; this asserts the affordance contract only.
  expect(html).toContain('data-pet-work-expand="running:internal"');
  expect(html).not.toContain('data-pet-work-expand="running:ext"');
  // The result panel only exists after an expand, never in the initial markup.
  expect(html).not.toContain("data-pet-work-latest-result");
  // The expand button is wired for assistive tech from the start.
  expect(html).toMatch(/data-pet-work-expand="running:internal"[^>]*aria-expanded="false"/);
  expect(html).toMatch(/data-pet-work-expand="running:internal"[^>]*aria-controls="/);
});

test("disables an external item whose locator is incomplete and explains why", () => {
  const incomplete: PetWorkMap = {
    groups: [
      {
        workspace: "codeshell",
        latestActivityAt: 1,
        buckets: [
          {
            group: "other",
            items: [
              {
                id: "other:external",
                group: "other",
                state: "idle",
                title: "已删除 transcript",
                lastActivityAt: 1,
                external: { cli: "claude" },
                navigation: { agentSessionId: "external" },
              },
            ],
          },
        ],
      },
    ],
    counts: { running: 0, pending: 0, completed: 0, other: 1 },
    itemIds: {
      running: [],
      pending: [],
      completed: [],
      other: ["other:external"],
    },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };

  const html = renderToStaticMarkup(<PetWorkTree workMap={incomplete} defaultOpen />);
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*title="外部会话定位信息不完整或 transcript 已不存在，无法打开"/,
  );
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
    counts: { running: 0, pending: 1, completed: 0, other: 0 },
    itemIds: {
      running: [],
      pending: ["pending:risk:r1"],
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
    counts: { running: 0, pending: 0, completed: 0, other: 1 },
    itemIds: { running: [], pending: [], completed: [], other: ["other:x"] },
    dismissedCount: 0,
    hiddenCount: 0,
    unclassifiedCount: 0,
  };
  const html = renderToStaticMarkup(<PetWorkTree workMap={otherOnly} defaultOpen />);
  expect(html).toContain("闲置会话");
  expect(html).toContain("其他"); // pet.work.branch.other zh label
});
