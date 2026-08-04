import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshot, PetWorkInboxSnapshot } from "../../preload/types";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DialogProvider } from "../ui/DialogProvider";
import { countVisibleFollowUps, PetWorldPane } from "./PetWorldPane";

const reclaimed: PetProjectionSnapshot = {
  version: 1,
  generation: 0,
  workerState: "reclaimed",
  observedAt: 1_000,
  sessions: [],
  pending: [],
};

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElementByProp(node: unknown, prop: string): any {
  const current = node as { childNodes?: unknown[] };
  if (reactPropsOf(current)[prop] !== undefined) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElementByProp(child, prop);
    if (found) return found;
  }
  return undefined;
}

function textOf(node: unknown): string {
  const current = node as { data?: string; textContent?: string; childNodes?: unknown[] };
  if (current.data !== undefined) return current.data;
  const children = (current.childNodes ?? []).map(textOf).join("");
  return children || current.textContent || "";
}

describe("PetWorldPane", () => {
  test("counts only the canonical Needs follow-up rows that remain visible", () => {
    expect(
      countVisibleFollowUps(
        [
          {
            followUpId: "followup-handled",
            sessionId: "handled",
            title: "Handled",
            terminalAt: 1,
            text: "done",
          },
          {
            followUpId: "followup-open",
            sessionId: "open",
            title: "Open",
            terminalAt: 2,
            text: "next",
          },
        ],
        new Set(["follow-up:followup-handled"]),
      ),
    ).toBe(1);
    expect(
      countVisibleFollowUps(
        Array.from({ length: 25 }, (_, index) => ({
          followUpId: `followup-${index}`,
          sessionId: `session-${index}`,
          title: `Open ${index}`,
          terminalAt: index,
          text: "next",
        })),
        new Set(),
      ),
    ).toBe(20);
  });

  test("shows an empty work map without exposing a raw session list", () => {
    ensureMiniDom();
    (window as unknown as Record<string, any>).codeshell = { pet: {} };
    const html = renderToStaticMarkup(
      <DialogProvider>
        <PetWorldPane projection={reclaimed} status="ready" now={2_000} />
      </DialogProvider>,
    );

    expect(html).toContain("目前没有工作记录");
    expect(html).toContain("工作收件箱");
    expect(html).not.toContain("工作会话");
    expect(html).not.toContain("待你决定");
    expect(html).toContain('data-pet-world-pane="deterministic"');
    expect(html).toContain("self-stretch overflow-visible");
    expect(html).toContain("@container/work-pane");
    expect(html).toContain("@min-[1100px]/pet-page:col-start-2");
    expect(html).toContain("@min-[1100px]/pet-page:row-start-1");
    expect(html).toContain("@min-[1100px]/pet-page:overflow-hidden");
    expect(html).toContain("@min-[1100px]/pet-page:overflow-y-auto");
  });

  test("keeps a dedicated loading state without occupying the chat pane", () => {
    ensureMiniDom();
    (window as unknown as Record<string, any>).codeshell = { pet: {} };
    const html = renderToStaticMarkup(
      <DialogProvider>
        <PetWorldPane projection={null} status="loading" now={2_000} />
      </DialogProvider>,
    );
    expect(html).toContain("正在加载工作状态");
    expect(html).toContain("正在整理工作收件箱");
  });

  test("reports snapshot failure as retrying instead of looking freshly updated", () => {
    ensureMiniDom();
    (window as unknown as Record<string, any>).codeshell = { pet: {} };
    const html = renderToStaticMarkup(
      <DialogProvider>
        <PetWorldPane projection={null} status="error" now={2_000} />
      </DialogProvider>,
    );
    expect(html).toContain("加载失败，正在重试");
    expect(html).toContain("暂时无法加载会话");
    expect(html).not.toContain("刚刚更新");
  });

  test("emits a structured external locator when an external work item is opened", async () => {
    ensureMiniDom();
    const projection: PetProjectionSnapshot = {
      ...reclaimed,
      sessions: [
        {
          agentSessionId: "thread-123",
          runState: "running",
          queueDepth: 0,
          lastActivityAt: 1_500,
          pendingDecisionCount: 0,
          external: { cli: "codex", cwd: "/tmp/project" },
          freshness: {
            source: "external-tail",
            observedAt: 1_500,
            workerState: "active",
          },
        },
      ],
    };
    const requests: unknown[] = [];
    const testWindow = window as unknown as Record<string, any>;
    const originalCodeshell = testWindow.codeshell;
    testWindow.codeshell = {
      pet: {
        getDismissedWorkItemIds: async () => ({ revision: 1, dismissedIds: [] }),
        updateDismissedWorkItemIds: async () => ({ revision: 1, dismissedIds: [] }),
        onDismissedWorkItemIdsChanged: () => () => undefined,
      },
    };
    const container = document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DialogProvider>
          <PetWorldPane
            projection={projection}
            status="ready"
            now={2_000}
            onNavigate={(request) => requests.push(request)}
          />
        </DialogProvider>,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-drawer")).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-open")).onClick();
      await flushMicrotasks();
    });

    expect(requests).toEqual([
      {
        agentSessionId: "thread-123",
        external: { cli: "codex", cwd: "/tmp/project", sessionId: "thread-123" },
        snapshotVersion: 1,
        generation: 0,
      },
    ]);
    await act(async () => root.unmount());
    if (originalCodeshell === undefined) delete testWindow.codeshell;
    else testWindow.codeshell = originalCodeshell;
  });

  test("restore-dismissed keeps handled follow-ups hidden while restoring session rows", async () => {
    ensureMiniDom();
    const projection: PetProjectionSnapshot = {
      ...reclaimed,
      sessions: [
        {
          agentSessionId: "session-a",
          runState: "terminal",
          queueDepth: 0,
          lastActivityAt: 1_500,
          pendingDecisionCount: 0,
          terminal: { status: "completed", at: 1_500 },
          freshness: {
            source: "disk",
            observedAt: 1_500,
            workerState: "reclaimed",
          },
          title: "Completed session",
        },
      ],
    };
    const updates: unknown[] = [];
    let resolveUpdate: ((snapshot: PetWorkInboxSnapshot) => void) | undefined;
    const testWindow = window as unknown as Record<string, any>;
    const originalCodeshell = testWindow.codeshell;
    testWindow.codeshell = {
      pet: {
        getDismissedWorkItemIds: async () => ({
          revision: 1,
          dismissedIds: ["completed:session-a", "follow-up:followup-handled"],
        }),
        updateDismissedWorkItemIds: (update: unknown) => {
          updates.push(update);
          return new Promise<PetWorkInboxSnapshot>((resolve) => {
            resolveUpdate = resolve;
          });
        },
        onDismissedWorkItemIdsChanged: () => () => undefined,
        getSummaries: async () => [
          {
            followUpId: "followup-handled",
            sessionId: "session-a",
            title: "Handled follow-up",
            terminalAt: 1_500,
            text: "已处理的跟进事项",
          },
        ],
      },
    };
    const container = document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DialogProvider>
          <PetWorldPane projection={projection} status="ready" now={2_000} />
        </DialogProvider>,
      );
      // useFollowUps 的首次拉取走 setTimeout(0)，微任务冲不掉。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });
    // 已处理的跟进（follow-up:* 已在 dismissed 集合里）不应显示。
    expect(textOf(container)).not.toContain("已处理的跟进事项");

    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-drawer")).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-restore")).onClick();
      await flushMicrotasks();
    });

    // 「恢复已忽略」只还原会话行，绝不能把已处理的跟进复活——
    // 主进程回包之前，本地乐观状态就必须保住 follow-up:* 的已处理标记。
    expect(textOf(container)).toContain("Completed session");
    expect(textOf(container)).not.toContain("已处理的跟进事项");
    expect(updates).toEqual([{ action: "clear" }]);

    await act(async () => {
      resolveUpdate?.({ revision: 2, dismissedIds: ["follow-up:followup-handled"] });
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("已处理的跟进事项");

    await act(async () => root.unmount());
    if (originalCodeshell === undefined) delete testWindow.codeshell;
    else testWindow.codeshell = originalCodeshell;
  });

  test("does not let an equal-revision inbox event undo an optimistic dismissal", async () => {
    ensureMiniDom();
    const projection: PetProjectionSnapshot = {
      ...reclaimed,
      sessions: [
        {
          agentSessionId: "session-a",
          runState: "terminal",
          queueDepth: 0,
          lastActivityAt: 1_500,
          pendingDecisionCount: 0,
          terminal: { status: "completed", at: 1_500 },
          freshness: {
            source: "disk",
            observedAt: 1_500,
            workerState: "reclaimed",
          },
          title: "Completed session",
        },
      ],
    };
    let inboxListener: ((snapshot: PetWorkInboxSnapshot) => void) | undefined;
    let resolveUpdate: ((snapshot: PetWorkInboxSnapshot) => void) | undefined;
    const testWindow = window as unknown as Record<string, any>;
    const originalCodeshell = testWindow.codeshell;
    testWindow.codeshell = {
      pet: {
        getDismissedWorkItemIds: async () => ({ revision: 4, dismissedIds: [] }),
        updateDismissedWorkItemIds: () =>
          new Promise<PetWorkInboxSnapshot>((resolve) => {
            resolveUpdate = resolve;
          }),
        onDismissedWorkItemIdsChanged: (listener: (snapshot: PetWorkInboxSnapshot) => void) => {
          inboxListener = listener;
          return () => {
            inboxListener = undefined;
          };
        },
      },
    };
    const container = document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DialogProvider>
          <PetWorldPane projection={projection} status="ready" now={2_000} />
        </DialogProvider>,
      );
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-drawer")).onClick();
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("Completed session");

    await act(async () => {
      reactPropsOf(findElementByProp(container, "data-pet-work-dismiss")).onClick();
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("Completed session");

    await act(async () => {
      inboxListener?.({ revision: 4, dismissedIds: [] });
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("Completed session");

    await act(async () => {
      resolveUpdate?.({ revision: 5, dismissedIds: ["completed:session-a"] });
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("Completed session");

    await act(async () => root.unmount());
    if (originalCodeshell === undefined) delete testWindow.codeshell;
    else testWindow.codeshell = originalCodeshell;
  });
});
