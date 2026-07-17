import { describe, expect, test } from "bun:test";
import type { PetProjectionSnapshot, PetWorkInboxSnapshot } from "../../preload/types";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetWorldPane } from "./PetWorldPane";

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
  test("shows an empty work map without exposing a raw session list", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={reclaimed} status="ready" now={2_000} />,
    );

    expect(html).toContain("目前没有工作记录");
    expect(html).toContain("工作收件箱");
    expect(html).not.toContain("工作会话");
    expect(html).not.toContain("待你决定");
    expect(html).toContain('data-pet-world-pane="deterministic"');
  });

  test("keeps a dedicated loading state without occupying the chat pane", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={null} status="loading" now={2_000} />,
    );
    expect(html).toContain("正在加载工作状态");
    expect(html).toContain("正在整理工作收件箱");
  });

  test("reports snapshot failure as retrying instead of looking freshly updated", () => {
    const html = renderToStaticMarkup(
      <PetWorldPane projection={null} status="error" now={2_000} />,
    );
    expect(html).toContain("加载失败，正在重试");
    expect(html).toContain("暂时无法加载会话");
    expect(html).not.toContain("刚刚更新");
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
      root.render(<PetWorldPane projection={projection} status="ready" now={2_000} />);
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
