import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  TaskInboxListResult,
  TaskInboxActionResult,
  TaskInboxRecordV1,
} from "../../preload/task-inbox-api";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
}));
const { DialogProvider } = await import("../ui/DialogProvider");
const { TaskInboxPage } = await import("./TaskInboxPage");
function row(id: string, patch: Partial<TaskInboxRecordV1> = {}): TaskInboxRecordV1 {
  return {
    schemaVersion: 1,
    taskKey: `session:${id}`,
    source: "session",
    sourceId: id,
    title: `任务 ${id}`,
    status: "running",
    sessionId: id,
    artifacts: [],
    capabilities: ["open"],
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_001_000,
    sourceRevision: "r1",
    ...patch,
  };
}
function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
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
const snapshot = (records: TaskInboxRecordV1[], version = 1): TaskInboxListResult => ({
  version,
  records,
  errors: [],
});

describe("TaskInboxPage", () => {
  let root: Root;
  let container: HTMLElement;
  let bridgeBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let requestFrameBefore: PropertyDescriptor | undefined;
  let cancelFrameBefore: PropertyDescriptor | undefined;
  let requests: Array<{
    query: unknown;
    request: ReturnType<typeof deferred<TaskInboxListResult>>;
  }>;
  let actions: unknown[];
  let result: TaskInboxActionResult;
  let changed: (version: number) => void;
  let unsubscribed: boolean;
  let opened: TaskInboxRecordV1[];
  beforeEach(() => {
    ensureMiniDom();
    requestFrameBefore = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
    cancelFrameBefore = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => undefined;
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    requests = [];
    actions = [];
    result = { status: "ok" };
    unsubscribed = false;
    opened = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        taskInbox: {
          list: (query: unknown) => {
            const request = deferred<TaskInboxListResult>();
            requests.push({ query, request });
            return request.promise;
          },
          act: async (input: unknown) => {
            actions.push(input);
            return result;
          },
          onChanged: (listener: (version: number) => void) => {
            changed = listener;
            return () => {
              unsubscribed = true;
            };
          },
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
    expect(unsubscribed).toBe(true);
    if (requestFrameBefore)
      Object.defineProperty(window, "requestAnimationFrame", requestFrameBefore);
    else Reflect.deleteProperty(window, "requestAnimationFrame");
    if (cancelFrameBefore) Object.defineProperty(window, "cancelAnimationFrame", cancelFrameBefore);
    else Reflect.deleteProperty(window, "cancelAnimationFrame");
    document.body.removeChild(container);
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const settle = async (action: () => void) => {
    await act(async () => {
      action();
      await flushMicrotasks();
    });
  };
  const render = async () =>
    settle(() =>
      root.render(
        <DialogProvider>
          <TaskInboxPage
            onOpenTaskInboxRecord={(record) => {
              opened.push(record);
            }}
          />
        </DialogProvider>,
      ),
    );
  const nodes = () => descendants(container);
  const button = (text: string) => {
    const node = nodes().find((item) => item.tagName === "BUTTON" && textOf(item) === text);
    expect(node).toBeDefined();
    return node!;
  };
  const click = async (node: Element) => settle(() => props(node).onClick());
  const cards = () => nodes().filter((node) => node.tagName === "ARTICLE");

  test("existing activity Session detail loads masked writes on demand and delegates resolution to native confirmation", async () => {
    const calls: unknown[] = [];
    let resolved = false;
    (window.codeshell as any).operationResolution = {
      review: async (sessionId: string) => {
        calls.push(["review", sessionId]);
        return {
          reviewToken: "native-token",
          truncated: false,
          records: [
            {
              id: "operation",
              revision: "receipt-cas",
              service: "github",
              action: "create_issue",
              createdAt: 1,
              state: "unknown",
              hasReference: false,
              canResolve: !resolved,
              ...(resolved ? { resolvedAt: 2 } : {}),
            },
          ],
        };
      },
      resolve: async (input: unknown) => {
        calls.push(["native", input]);
        resolved = true;
        return { status: "resolved", result: "unknown" };
      },
    };
    await render();
    await settle(() =>
      requests[0].request.resolve(snapshot([row("uncertain", { status: "failed" })])),
    );
    expect(calls).toEqual([]);
    await click(button("外部写入人工处理"));
    expect(calls).toEqual([["review", "uncertain"]]);
    expect(textOf(container)).toContain("缺少原始引用");
    await click(button("人工核查后处理…"));
    expect(calls[1]).toEqual([
      "native",
      { reviewToken: "native-token", operationId: "operation", revision: "receipt-cas" },
    ]);
    expect(textOf(container)).toContain("已人工接受未知结果；结果仍未知");
    expect(cards()).toHaveLength(1);
    expect(textOf(container)).not.toContain("PRIVATE_BODY");
  });

  test("a committed native decision followed by refresh failure is reported as accepted, never as a retained barrier", async () => {
    let reads = 0;
    (window.codeshell as any).operationResolution = {
      review: async () => {
        if (++reads > 1) throw new Error("refresh unavailable");
        return {
          reviewToken: "token",
          truncated: false,
          records: [
            {
              id: "op",
              revision: "cas",
              service: "github",
              action: "create_issue",
              createdAt: 1,
              canResolve: true,
            },
          ],
        };
      },
      resolve: async () => ({ status: "resolved", result: "unknown" }),
    };
    await render();
    await settle(() =>
      requests[0].request.resolve(snapshot([row("uncertain", { status: "failed" })])),
    );
    await click(button("外部写入人工处理"));
    await click(button("人工核查后处理…"));
    expect(textOf(container)).toContain("已人工接受未知结果；结果仍未知。刷新失败");
    expect(textOf(container)).not.toContain("阻断仍保留");
    expect(button("刷新记录")).toBeDefined();
  });

  test("groups waiting first, labels filters and exposes only real capabilities", async () => {
    await render();
    await settle(() =>
      requests[0].request.resolve(
        snapshot([
          row("done", {
            status: "done",
            source: "legacy-run",
            capabilities: ["open"],
            workspacePath: "/work/a",
          }),
          row("run"),
          row("wait", { status: "waiting", capabilities: ["open", "pause"], summary: "需要审批" }),
          row("fail", { status: "failed" }),
        ]),
      ),
    );
    expect(cards().map((node) => props(node)["aria-label"])).toEqual([
      "任务 wait",
      "任务 run",
      "任务 fail",
      "任务 done",
    ]);
    expect(textOf(cards()[0])).toContain("需要审批");
    expect(textOf(cards()[3])).toContain("仅查看");
    expect(textOf(cards()[3])).toContain("/work/a");
    expect(nodes().filter((node) => node.tagName === "SELECT")).toHaveLength(3);
    expect(
      nodes()
        .filter((node) => node.tagName === "LABEL")
        .map((node) => props(node).htmlFor)
        .every(Boolean),
    ).toBe(true);
    expect(
      nodes().filter(
        (node) => node.tagName === "BUTTON" && props(node)["aria-label"] === "打开来源：任务 done",
      ),
    ).toHaveLength(1);
    expect(textOf(container)).not.toContain("取消任务");
    const source = nodes().find(
      (node) => node.tagName === "SELECT" && String(props(node).id).endsWith("-source"),
    )!;
    await settle(() => props(source).onChange({ target: { value: "legacy-run" } }));
    expect(cards()).toHaveLength(1);
    const input = nodes().find((node) => node.tagName === "INPUT")!;
    await settle(() => props(input).onChange({ target: { value: "missing" } }));
    expect(textOf(container)).toContain("没有符合筛选条件的任务");
  });
  test("pagination includes later tasks and changed events refresh once newer than the current snapshot", async () => {
    await render();
    await settle(() => requests[0].request.resolve({ ...snapshot([row("a")]), nextCursor: "p2" }));
    expect(requests[1].query).toEqual({ limit: 200, cursor: "p2" });
    await settle(() => requests[1].request.resolve(snapshot([row("b")])));
    expect(cards()).toHaveLength(2);
    await settle(() => changed(1));
    expect(requests).toHaveLength(2);
    await settle(() => changed(2));
    expect(requests).toHaveLength(3);
    await settle(() =>
      requests[2].request.resolve(snapshot([row("completed", { status: "done" })], 2)),
    );
    expect(textOf(container)).toContain("任务 completed");
    expect(cards()).toHaveLength(1);
  });
  test("continuous updates finish and publish an immutable paginated snapshot before following the newest version", async () => {
    await render();
    await settle(() => {
      changed(3);
      changed(3);
    });
    expect(requests).toHaveLength(1);
    await settle(() =>
      requests[0].request.resolve({
        ...snapshot([row("first-page")], 1),
        nextCursor: "snapshot-one:p2",
      }),
    );
    expect(requests[1].query).toEqual({ limit: 200, cursor: "snapshot-one:p2" });
    await settle(() => {
      changed(7);
      changed(5);
      changed(8);
    });
    expect(requests).toHaveLength(2);
    await settle(() =>
      requests[1].request.resolve({
        ...snapshot([row("second-page")], 1),
        nextCursor: "snapshot-one:p3",
      }),
    );
    await settle(() => {
      changed(8);
      changed(9);
    });
    expect(requests).toHaveLength(3);
    await settle(() => requests[2].request.resolve(snapshot([row("third-page")], 1)));
    // All three pages are visible even though the latest refresh has begun.
    expect(cards()).toHaveLength(3);
    expect(textOf(container)).toContain("任务 first-page");
    expect(textOf(container)).toContain("任务 second-page");
    expect(textOf(container)).toContain("任务 third-page");
    expect(requests).toHaveLength(4);
    expect(requests[3].query).toEqual({ limit: 200 });
    await settle(() => {
      changed(10);
      changed(10);
    });
    expect(requests).toHaveLength(4);
    await settle(() =>
      requests[3].request.resolve({
        ...snapshot([row("newest-first")], 10),
        nextCursor: "snapshot-ten:p2",
      }),
    );
    await settle(() => changed(9));
    await settle(() => requests[4].request.resolve(snapshot([row("newest-last")], 10)));
    expect(cards()).toHaveLength(2);
    expect(textOf(container)).toContain("任务 newest-first");
    expect(textOf(container)).toContain("任务 newest-last");
    expect(textOf(container)).not.toContain("任务 first-page");
    expect(requests).toHaveLength(5);
    // A missed event still converges through an explicit refresh.
    await click(button("刷新"));
    await settle(() => requests[5].request.resolve(snapshot([row("after-missed-event")], 11)));
    expect(textOf(container)).toContain("任务 after-missed-event");
  });
  test("an explicit action refresh invalidates an older in-flight generation", async () => {
    await render();
    await settle(() => requests[0].request.resolve(snapshot([row("a")], 1)));
    await settle(() => changed(2));
    await click(button("打开来源"));
    expect(requests).toHaveLength(3);
    await settle(() => requests[2].request.resolve(snapshot([row("newest")], 3)));
    await settle(() => requests[1].request.resolve(snapshot([row("late-old")], 2)));
    expect(textOf(container)).toContain("任务 newest");
    expect(textOf(container)).not.toContain("任务 late-old");
  });
  test("a change during pagination restarts rather than presenting mixed versions", async () => {
    await render();
    await settle(() =>
      requests[0].request.resolve({ ...snapshot([row("old-page")], 1), nextCursor: "p2" }),
    );
    await settle(() => requests[1].request.resolve(snapshot([row("mixed-page")], 2)));
    expect(requests).toHaveLength(3);
    await settle(() => requests[2].request.resolve(snapshot([row("consistent")], 2)));
    expect(cards()).toHaveLength(1);
    expect(textOf(container)).toContain("任务 consistent");
    expect(textOf(container)).not.toContain("任务 old-page");
    expect(textOf(container)).not.toContain("任务 mixed-page");
  });
  test("partial source errors and stale records stay visible; failed refresh preserves them", async () => {
    await render();
    await settle(() =>
      requests[0].request.resolve({
        ...snapshot([row("old", { stale: true, capabilities: ["open", "pause"] })]),
        errors: [{ source: "automation", message: "temporary outage" }],
      }),
    );
    expect(textOf(container)).toContain("temporary outage");
    expect(textOf(container)).toContain("状态可能已过期");
    expect(props(button("暂停")).disabled).toBe(true);
    await click(button("刷新"));
    await settle(() => requests[1].request.reject(new Error("offline")));
    expect(cards()).toHaveLength(1);
    expect(textOf(container)).toContain("offline");
  });
  test("open validates revision, invokes original detail callback and stale failures refresh", async () => {
    await render();
    await settle(() => requests[0].request.resolve(snapshot([row("a")])));
    await click(button("打开来源"));
    expect(actions).toEqual([{ taskKey: "session:a", action: "open", expectedRevision: "r1" }]);
    expect(opened.map((record) => record.sourceId)).toEqual(["a"]);
    await settle(() =>
      requests[1].request.resolve(snapshot([row("a", { capabilities: ["pause"] })], 2)),
    );
    result = { status: "stale" };
    await click(button("暂停"));
    expect(textOf(container)).toContain("任务状态已变化");
    expect(requests).toHaveLength(3);
  });
  test("a durable child opens its exact transcript without a live observer or ordinary Session import", async () => {
    const reads: string[] = [];
    const queries: unknown[] = [];
    Object.assign(window.codeshell, {
      getSessionTranscript: async (id: string) => {
        reads.push(id);
        return [{ kind: "user", text: "持久子任务原始对话" }];
      },
      listDiskSessions: async (query: unknown) => {
        queries.push(query);
        return { sessions: [], nextCursor: null };
      },
    });
    await render();
    await settle(() =>
      requests[0].request.resolve(
        snapshot([
          row("child", {
            source: "subagent",
            sourceId: "child-engine",
            sessionId: "child-engine",
            parentSessionId: "parent-engine",
            status: "done",
          }),
        ]),
      ),
    );
    await click(button("打开来源"));
    await act(async () => {
      await import("../subagents/SubagentSessionDetail");
      await flushMicrotasks();
    });
    expect(reads).toEqual(["child-engine"]);
    expect(queries).toEqual([{ parentSessionId: "parent-engine", limit: 100, cursor: undefined }]);
    expect(textOf(container)).toContain("持久子任务原始对话");
    expect(opened).toEqual([]);
  });
  test("cancel and retry require explicit confirmation and denied confirmation sends nothing", async () => {
    await render();
    await settle(() =>
      requests[0].request.resolve(snapshot([row("a", { capabilities: ["cancel", "retry"] })])),
    );
    await click(button("取消任务"));
    expect(actions).toHaveLength(0);
    expect(textOf(container)).toContain("取消“任务 a”？");
    await click(button("取消"));
    expect(actions).toHaveLength(0);
    await click(button("重试"));
    expect(textOf(container)).toContain("再次消耗模型额度");
    await click(button("确认"));
    expect(actions).toEqual([{ taskKey: "session:a", action: "retry", expectedRevision: "r1" }]);
  });
});
