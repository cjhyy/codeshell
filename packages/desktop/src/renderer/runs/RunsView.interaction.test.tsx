import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunDetail, RunSummary } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { RunsView } from "./RunsView";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? node.textContent ?? "";
  return node.childNodes.length
    ? Array.from(node.childNodes).map(textOf).join("")
    : (node.textContent ?? "");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function run(runId: string, status = "running"): RunDetail {
  return {
    runId,
    objective: `目标 ${runId}`,
    status,
    cwd: `/workspace/${"long-path/".repeat(12)}`,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_001_000,
    startedAt: null,
    finishedAt: null,
    sessionId: `session-${runId}`,
    error: null,
    summary: `摘要 ${runId}`,
    prompt: `完整 prompt ${runId}`,
    model: "test-model",
    provider: "test-provider",
    durationMs: 1_250,
    usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    attemptCount: 1,
    latestCheckpointId: null,
    latestApprovalId: null,
    tags: [],
    metadata: {},
    checkpoints: [],
    artifacts: [`/workspace/${"artifact/".repeat(15)}file.txt`],
    events: [
      {
        eventId: `started-${runId}`,
        type: "run_started",
        timestamp: 1_800_000_000_000,
        data: {},
      },
      {
        eventId: `tool-${runId}`,
        type: "tool_use",
        timestamp: 1_800_000_000_100,
        data: { toolName: "Read", toolCallId: `call-${runId}`, args: { file: "/tmp/a" } },
      },
      {
        eventId: `result-${runId}`,
        type: "tool_result",
        timestamp: 1_800_000_001_000,
        data: { toolName: "Read", toolCallId: `call-${runId}`, result: "file body" },
      },
    ],
  };
}

describe("RunsView loading and selection", () => {
  let root: Root;
  let container: HTMLElement;
  let bridgeBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let lists: Array<ReturnType<typeof deferred<RunSummary[]>>>;
  let details: Array<{ id: string; request: ReturnType<typeof deferred<RunDetail | null>> }>;

  beforeEach(() => {
    ensureMiniDom();
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    lists = [];
    details = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        listRuns: (options?: { includeSessions?: boolean }) => {
          expect(options).toEqual({ includeSessions: true });
          const request = deferred<RunSummary[]>();
          lists.push(request);
          return request.promise;
        },
        getRun: (id: string) => {
          const request = deferred<RunDetail | null>();
          details.push({ id, request });
          return request.promise;
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const render = async (initialRunId?: string) => {
    await act(async () => {
      root.render(<RunsView initialRunId={initialRunId} />);
      await flushMicrotasks();
    });
  };
  const settle = async (action: () => void) => {
    await act(async () => {
      action();
      await flushMicrotasks();
    });
  };
  const button = (text: string) => {
    const node = descendants(container).find(
      (candidate) => candidate.tagName === "BUTTON" && textOf(candidate) === text,
    );
    expect(node).toBeDefined();
    return node as HTMLButtonElement;
  };
  const choices = () =>
    descendants(container).filter(
      (node) =>
        node.tagName === "BUTTON" &&
        props(node)["aria-controls"] &&
        props(node)["aria-pressed"] !== undefined,
    );
  const pane = () =>
    descendants(container).find(
      (node) => props(node).role === "region" && props(node)["aria-label"] === "运行详情",
    ) as HTMLElement;
  const click = (node: Element) => settle(() => props(node).onClick());
  const ariaButton = (label: string) => {
    const node = descendants(container).find(
      (candidate) => candidate.tagName === "BUTTON" && props(candidate)["aria-label"] === label,
    );
    expect(node).toBeDefined();
    return node as HTMLButtonElement;
  };
  const search = () =>
    descendants(container).find(
      (candidate) => candidate.tagName === "INPUT" && props(candidate).type === "search",
    ) as HTMLInputElement;
  const searchFor = (value: string) =>
    settle(() => props(search()).onChange({ target: { value } }));

  test("uses native keyboard-selectable rows with readable status and linked details", async () => {
    await render();
    await settle(() => lists[0].resolve([run("a", "waiting_input"), run("b", "completed")]));
    expect(details).toHaveLength(0);
    const rows = choices();
    expect(rows).toHaveLength(2);
    expect(props(rows[0]).type).toBe("button");
    expect(textOf(rows[0])).toContain("等待输入");
    expect(textOf(rows[0])).not.toContain("waiting_input");
    await click(rows[1]);
    expect(details.map(({ id }) => id)).toEqual(["b"]);
    expect(props(choices()[1])["aria-pressed"]).toBe(true);
    expect(props(choices()[1])["aria-controls"]).toBe(pane().getAttribute("id"));
    expect(props(pane()).tabIndex).toBe(0);
    await settle(() => details[0].request.resolve(run("b", "completed")));
    expect(textOf(pane())).toContain("摘要 b");
    expect(textOf(pane())).toContain("已完成");
    expect(textOf(pane())).toContain("开始运行");
    expect(textOf(pane())).toContain("session-b");
    expect(textOf(pane())).toContain(run("b").cwd);
    expect(textOf(pane())).toContain("完整 prompt b");
    expect(textOf(pane())).toContain("test-model");
    expect(textOf(pane())).toContain("150");
    expect(textOf(pane())).toContain("Read");
    expect(textOf(pane())).toContain("调用工具 · Read");
  });

  test("an initial run outside the list can load, and a newer deep link ignores the older response", async () => {
    await render("outside");
    await settle(() => lists[0].resolve([]));
    expect(details.map(({ id }) => id)).toEqual(["outside"]);
    await render("newer");
    expect(details.map(({ id }) => id)).toEqual(["outside", "newer"]);
    await settle(() => details[1].request.resolve(run("newer")));
    await settle(() => details[0].request.resolve(run("outside")));
    expect(textOf(pane())).toContain("摘要 newer");
    expect(textOf(pane())).not.toContain("摘要 outside");
  });

  test("switching rows clears old details while loading and ignores a late rejection", async () => {
    await render();
    await settle(() => lists[0].resolve([run("a"), run("b")]));
    await click(choices()[0]);
    await click(choices()[1]);
    expect(textOf(pane())).toContain("正在加载运行详情");
    await settle(() => details[1].request.resolve(run("b")));
    await settle(() => details[0].request.reject(new Error("old failure")));
    expect(textOf(pane())).toContain("摘要 b");
    expect(textOf(pane())).not.toContain("old failure");
  });

  test("an initial list failure keeps the title and recovers without a stale error", async () => {
    await render();
    await settle(() => lists[0].reject(new Error("temporary outage")));
    expect(textOf(container)).toContain("运行记录");
    expect(textOf(container)).toContain("temporary outage");
    await click(button("重试加载"));
    expect(textOf(container)).not.toContain("temporary outage");
    expect(document.activeElement === button("刷新")).toBe(true);
    expect(props(button("刷新"))["aria-disabled"]).toBe(true);
    await click(button("刷新"));
    expect(lists).toHaveLength(2);
    await settle(() => lists[1].resolve([run("recovered")]));
    expect(textOf(container)).toContain("目标 recovered");
    expect(textOf(container)).not.toContain("temporary outage");
  });

  test("a failed refresh retains the list, refreshes the selected detail, and can retry", async () => {
    await render("a");
    await settle(() => {
      lists[0].resolve([run("a")]);
      details[0].request.resolve(run("a"));
    });
    await click(button("刷新"));
    await settle(() => {
      lists[1].reject(new Error("refresh failed"));
      details[1].request.resolve({ ...run("a"), summary: "updated detail" });
    });
    expect(choices()).toHaveLength(1);
    expect(textOf(pane())).toContain("updated detail");
    await click(button("重试加载"));
    await settle(() => {
      lists[2].resolve([run("a"), run("b")]);
      details[2].request.resolve(run("a"));
    });
    expect(choices()).toHaveLength(2);
    expect(textOf(container)).not.toContain("refresh failed");
  });

  test("detail errors and missing runs retry independently of the list", async () => {
    await render("a");
    await settle(() => {
      lists[0].resolve([]);
      details[0].request.reject(new Error("detail failed"));
    });
    await click(button("重试详情"));
    expect(document.activeElement === pane()).toBe(true);
    expect(textOf(pane())).not.toContain("detail failed");
    await settle(() => details[1].request.resolve(null));
    expect(textOf(pane())).toContain("找不到这次运行");
    await click(button("重试详情"));
    await settle(() => details[2].request.resolve(run("a")));
    expect(textOf(pane())).toContain("摘要 a");
    expect(lists).toHaveLength(1);
  });

  test("large lists are paged, search spans all pages, and hidden selection is retained", async () => {
    await render("row-2");
    await settle(() => {
      lists[0].resolve(Array.from({ length: 121 }, (_, index) => run(`row-${index}`)));
      details[0].request.resolve(run("row-2"));
    });
    expect(choices()).toHaveLength(50);
    await click(ariaButton("下一页运行"));
    expect(choices()).toHaveLength(50);
    expect(textOf(choices()[0])).toContain("目标 row-50");
    expect(textOf(pane())).toContain("摘要 row-2");
    await searchFor("row-120");
    expect(choices()).toHaveLength(1);
    expect(textOf(choices()[0])).toContain("目标 row-120");
    expect(textOf(pane())).toContain("当前运行不在筛选结果中");
    expect(textOf(pane())).toContain("摘要 row-2");
    expect(details).toHaveLength(1);
    await searchFor("missing record");
    expect(textOf(container)).toContain("没有符合搜索和状态筛选的运行");
    await click(button("清空筛选条件"));
    expect(choices()).toHaveLength(50);
    expect(textOf(choices()[0])).toContain("目标 row-0");
    expect(document.activeElement === search()).toBe(true);
  });

  test("a deep link reveals its list page while refresh keeps the page bounded", async () => {
    await render("row-120");
    await settle(() => {
      lists[0].resolve(Array.from({ length: 121 }, (_, index) => run(`row-${index}`)));
      details[0].request.resolve(run("row-120"));
    });
    expect(choices()).toHaveLength(21);
    expect(props(choices().at(-1)!)["aria-pressed"]).toBe(true);
    expect(textOf(container)).toContain("第 3 / 3 页");
    await click(button("刷新"));
    await settle(() => {
      lists[1].resolve([run("row-120")]);
      details[1].request.resolve(run("row-120"));
    });
    expect(choices()).toHaveLength(1);
    expect(props(choices()[0])["aria-pressed"]).toBe(true);
    expect(textOf(pane())).toContain("摘要 row-120");
  });

  test("refresh retains expanded detail and scroll position through an error and retry", async () => {
    await render("a");
    await settle(() => {
      lists[0].resolve([run("a")]);
      details[0].request.resolve(run("a"));
    });
    expect(textOf(pane())).not.toContain("file body");
    const disclosure = descendants(pane()).find((node) => node.tagName === "DETAILS")!;
    await settle(() => props(disclosure).onToggle({ currentTarget: { open: true } }));
    expect(textOf(pane())).toContain("file body");
    pane().scrollTop = 150;
    await click(button("刷新"));
    expect(textOf(pane())).toContain("摘要 a");
    expect(textOf(pane())).toContain("file body");
    expect(pane().scrollTop).toBe(150);
    expect(props(pane())["aria-busy"]).toBe(true);
    await settle(() => {
      lists[1].resolve([run("a")]);
      details[1].request.reject(new Error("temporary detail outage"));
    });
    expect(textOf(pane())).toContain("显示上次加载的记录");
    expect(textOf(pane())).toContain("temporary detail outage");
    expect(textOf(pane())).toContain("file body");
    expect(props(pane())["aria-busy"]).toBe(false);
    await click(button("重试详情"));
    await settle(() => details[2].request.resolve({ ...run("a"), summary: "new summary" }));
    expect(textOf(pane())).toContain("new summary");
    expect(textOf(pane())).toContain("file body");
    expect(textOf(pane())).not.toContain("temporary detail outage");
    expect(lists).toHaveLength(2);
  });

  test("synchronous repeated refresh actions start only one list request", async () => {
    await render();
    await settle(() => lists[0].resolve([run("a")]));
    const refresh = button("刷新");
    await settle(() => {
      props(refresh).onClick();
      props(refresh).onClick();
    });
    expect(lists).toHaveLength(2);
  });

  test("renders known estimates with explicit unknown and partial coverage in the existing history page", async () => {
    window.codeshell.getUsageSummary = async () => ({
      version: 1,
      scope: "store",
      includesChildren: false,
      requests: 2,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      knownEstimatedCostUsd: 0.00045,
      unknownCostRequests: 1,
      unknownUsageRequests: 1,
      partial: true,
      persistenceErrors: 0,
      invalidReceipts: 1,
      scannedReceipts: 2,
      byModel: [],
      bySession: [],
      byPurpose: [],
    });
    await act(async () => {
      root.render(<RunsView />);
      await flushMicrotasks();
    });
    const content = textOf(container);
    expect(content).toContain("0.000450");
    expect(content).toContain("1");
    expect(content).toMatch(/unknown|未知/);
    expect(content).toMatch(/incomplete|不完整/);
    expect(
      descendants(container).some((node) =>
        node.getAttribute("aria-label")?.match(/Cross-session|cross-session|跨会话/),
      ),
    ).toBe(true);
  });
});
