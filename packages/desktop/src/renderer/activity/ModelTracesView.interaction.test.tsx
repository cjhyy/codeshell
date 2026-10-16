import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ModelTraceApi,
  ModelTraceConfig,
  ModelTraceListQuery,
  ModelTraceRecord,
  ModelTraceSummary,
} from "../../preload/model-trace-api";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ModelTracesView } from "./ModelTracesView";
import { eventIndent, eventRequestId, groupModelTraces } from "./modelTracePresentation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function nodes(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(nodes)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((value) => value.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
}
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? "";
  return node.childNodes.length
    ? Array.from(node.childNodes).map(textOf).join("")
    : (node.textContent ?? "");
}
function record(
  id: string,
  traceId = "execution-a",
  patch: Partial<ModelTraceRecord> = {},
): ModelTraceRecord {
  return {
    version: 1,
    id,
    traceId,
    sessionId: "session-a",
    runId: "run-a",
    source: "desktop",
    purpose: "answer",
    provider: "provider-a",
    model: "model-a",
    startedAt: 1000,
    endedAt: 2500,
    status: "completed",
    stream: true,
    inputState: "recorded",
    input: {
      systemPrompt: "System snapshot at request time",
      messages: [{ role: "user", content: "Original user input" }],
      tools: [{ name: "Read", description: "Read a file" }],
      parameters: { temperature: 0.3 },
    },
    outputState: "recorded",
    output: { text: "Final answer from request", stopReason: "stop" },
    usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 },
    attempts: [
      {
        id: `${id}-attempt-1`,
        number: 1,
        startedAt: 1000,
        endedAt: 1200,
        status: "failed",
        coverage: "provider-wire",
        inputState: "recorded",
        input: {
          model: "wire-model",
          messages: [{ role: "user", content: "Final provider wire input" }],
        },
        outputState: "not-recorded",
        httpStatus: 429,
        error: "Rate limited",
      },
      {
        id: `${id}-attempt-2`,
        number: 2,
        startedAt: 1300,
        firstTokenAt: 1500,
        endedAt: 2500,
        status: "completed",
        coverage: "provider-wire",
        inputState: "recorded",
        input: { model: "wire-model", retry: true },
        outputState: "recorded",
        output: { text: "Final answer from attempt two" },
        usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 },
      },
    ],
    ...patch,
  };
}
function summary(value: ModelTraceRecord): ModelTraceSummary {
  const { input: _input, output: _output, attempts, ...rest } = value;
  return { ...rest, attemptCount: attempts.length };
}

describe("model trace observability", () => {
  let root: Root;
  let container: HTMLElement;
  let bridgeBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let records: ModelTraceRecord[];
  let config: ModelTraceConfig;
  let api: ModelTraceApi;
  let listCalls: ModelTraceListQuery[];
  let getCalls: string[];
  const settle = async (action?: () => void) =>
    act(async () => {
      action?.();
      await flushMicrotasks();
    });
  const button = (label: string) =>
    nodes(container).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === label,
    ) as HTMLButtonElement;
  const attr = (key: string, value: string) =>
    nodes(container).find((node) => props(node)[key] === value) as HTMLElement;
  const click = async (node: HTMLElement) => {
    expect(node).toBeDefined();
    node.focus();
    await settle(() => props(node).onClick());
  };
  const change = async (node: HTMLElement, value: string) =>
    settle(() => props(node).onChange({ target: { value } }));
  const render = async (initial: React.ComponentProps<typeof ModelTracesView> = {}) =>
    settle(() => root.render(<ModelTracesView {...initial} />));
  const selectedDetail = () =>
    nodes(container).find((node) => props(node)["data-trace-detail-id"] !== undefined);
  beforeEach(() => {
    ensureMiniDom();
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    records = [record("request-a"), record("request-b"), record("request-c", "execution-b")];
    config = { enabled: true, captureContent: false, retentionDays: 7, includeEphemeral: false };
    listCalls = [];
    getCalls = [];
    api = {
      list: async (query = {}) => {
        listCalls.push(query);
        return {
          items: records
            .filter((item) => !query.traceId || item.traceId === query.traceId)
            .filter((item) => !query.sessionId || item.sessionId === query.sessionId)
            .map(summary),
          total: records.length,
        };
      },
      get: async (id) => {
        getCalls.push(id);
        const value = records.find((item) => item.id === id);
        return value
          ? {
              record: value,
              events: [
                {
                  id: "tool-a",
                  parentId: value.id,
                  traceId: value.traceId,
                  kind: "tool",
                  name: "Read source",
                  startedAt: 1600,
                  endedAt: 1800,
                  status: "completed",
                  inputState: "recorded",
                  input: { path: "/source/file.ts" },
                  outputState: "recorded",
                  output: "Source file content",
                },
              ],
            }
          : null;
      },
      getConfig: async () => config,
      setConfig: async (patch) => {
        config = { ...config, ...patch };
        return config;
      },
    };
    Object.defineProperty(window, "codeshell", { configurable: true, value: { modelTraces: api } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.removeChild(container);
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("groups calls by trace identity and inspects logical input, provider retries and linked tools separately", async () => {
    await render();
    expect(nodes(container).filter((node) => props(node)["data-trace-group"])).toHaveLength(2);
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(2);
    expect(textOf(attr("data-trace-request", "request-a").parentNode!.parentNode!)).toContain(
      "Read source",
    );
    expect(textOf(selectedDetail()!)).toContain("System snapshot at request time");
    await click(attr("data-trace-attempt", "request-a-attempt-1"));
    expect(textOf(selectedDetail()!)).toContain("Final provider wire input");
    expect(textOf(selectedDetail()!)).toContain("429");
    await click(button("输出"));
    expect(textOf(selectedDetail()!)).toContain("正文未采集");
    expect(textOf(selectedDetail()!)).not.toContain("Final answer from request");
    await click(attr("data-trace-attempt", "request-a-attempt-2"));
    expect(textOf(selectedDetail()!)).toContain("Final answer from attempt two");
    expect(textOf(selectedDetail()!)).toContain("200 ms");
    await click(attr("data-trace-event", "tool-a"));
    expect(textOf(selectedDetail()!)).toContain("Source file content");
    await click(button("输入"));
    expect(textOf(selectedDetail()!)).toContain("/source/file.ts");
  });

  test("a late detail read cannot replace a newer selection", async () => {
    const old = deferred<Awaited<ReturnType<ModelTraceApi["get"]>>>();
    const normal = api.get;
    api.get = (id) => (id === "request-a" ? old.promise : normal(id));
    await render();
    await click(attr("data-trace-request", "request-b"));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-b");
    await settle(() => old.resolve({ record: records[0], events: [] }));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-b");
  });

  test("failed refresh retains the selected attempt, payload tab and collapsed tree", async () => {
    await render();
    await click(attr("data-trace-attempt", "request-a-attempt-2"));
    await click(button("输出"));
    const disclosure = nodes(container).find(
      (node) => props(node)["aria-label"] === "2 次尝试 · request-a",
    ) as HTMLElement;
    await click(disclosure);
    api.get = async () => {
      throw new Error("Owned detail read failed");
    };
    await click(button("刷新记录"));
    expect(textOf(container)).toContain("刷新失败，保留上次详情");
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-a-attempt-2");
    expect(textOf(selectedDetail()!)).toContain("Final answer from attempt two");
    expect(props(disclosure)["aria-expanded"]).toBe(false);
  });

  test("native content capture acknowledgement is required and does not fabricate old prompts", async () => {
    records = [
      record("request-a", "execution-a", {
        inputState: "not-recorded",
        input: undefined,
        outputState: "not-recorded",
        output: undefined,
        attempts: [],
      }),
    ];
    const saving = deferred<ModelTraceConfig>();
    const patches: unknown[] = [];
    api.setConfig = (patch) => {
      patches.push(patch);
      return saving.promise;
    };
    await render();
    const capture = nodes(container).find(
      (node) => node.tagName === "INPUT" && textOf(node.parentNode!) === "记录 Prompt 正文",
    ) as HTMLElement;
    await settle(() => {
      props(capture).onChange({ target: { checked: true } });
      props(capture).onChange({ target: { checked: true } });
    });
    expect(patches).toEqual([{ captureContent: true }]);
    expect(props(capture).checked).toBe(false);
    await settle(() => saving.resolve({ ...config, captureContent: true }));
    expect(props(capture).checked).toBe(true);
    expect(textOf(selectedDetail()!)).toContain("正文未采集");
    expect(textOf(selectedDetail()!)).not.toContain("System snapshot");
  });

  test("failed config writes keep native state and preserve readable traces", async () => {
    api.setConfig = async () => {
      throw new Error("settings read-only");
    };
    await render();
    const capture = nodes(container).find(
      (node) => node.tagName === "INPUT" && textOf(node.parentNode!) === "记录 Prompt 正文",
    ) as HTMLElement;
    await settle(() => props(capture).onChange({ target: { checked: true } }));
    expect(props(capture).checked).toBe(false);
    expect(textOf(container)).toContain("settings read-only");
    expect(selectedDetail()).toBeDefined();
  });

  test("paginates calls on the server and resets cursors for trimmed filters", async () => {
    api.list = async (query = {}) => {
      listCalls.push(query);
      return {
        items: [summary(query.cursor ? records[2] : records[0])],
        total: 3,
        ...(query.traceId || query.cursor ? {} : { nextCursor: "page-two" }),
      };
    };
    await render();
    await click(button("下一页"));
    expect(listCalls.filter((query) => !query.traceId).at(-1)?.cursor).toBe("page-two");
    const search = nodes(container).find(
      (node) => props(node)["aria-label"] === "搜索模型、用途、来源或编号",
    ) as HTMLElement;
    await change(search, "  model-b  ");
    expect(listCalls.filter((query) => !query.traceId).at(-1)).toEqual({
      limit: 50,
      search: "model-b",
    });
  });

  test("deep links load the exact request even when it is outside the filtered list", async () => {
    const normal = api.list;
    api.list = async (query = {}) => (query.traceId ? normal(query) : { items: [], total: 0 });
    await render({ initialSessionId: "target-session", initialRequestId: "request-c" });
    expect(getCalls).toEqual(["request-c"]);
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    expect(attr("data-trace-request", "request-c")).toBeDefined();
  });

  test("an initial request awaiting a read is never replaced by the first list result", async () => {
    const exact = deferred<Awaited<ReturnType<ModelTraceApi["get"]>>>();
    const normal = api.get;
    api.get = (id) => (id === "request-c" ? exact.promise : normal(id));
    await render({ initialRequestId: "request-c" });
    expect(getCalls).toEqual([]);
    expect(selectedDetail()).toBeUndefined();
    await settle(() => exact.resolve({ record: records[2], events: [] }));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
  });

  test("changing the navigation target resets the previous execution and payload selection", async () => {
    records[2].sessionId = "session-b";
    await render({ initialTraceId: "execution-a" });
    await click(attr("data-trace-attempt", "request-a-attempt-1"));
    await render({ initialSessionId: "session-b" });
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    expect(textOf(selectedDetail()!)).not.toContain("Rate limited");
    expect(props(attr("data-trace-group", "execution-b"))["aria-pressed"]).toBe(true);
    expect(listCalls.filter((query) => query.sessionId).at(-1)?.sessionId).toBe("session-b");
  });

  test("expired calls remove cached content instead of presenting it as current", async () => {
    await render();
    api.get = async () => null;
    await click(button("刷新记录"));
    expect(selectedDetail()).toBeUndefined();
    expect(textOf(container)).toContain("这条调用已过期");
    expect(textOf(container)).not.toContain("System snapshot at request time");
  });

  test("external CLI logical captures expose their coverage limitation", async () => {
    records = [
      record("external-request", "external-trace", {
        source: "external-cli-input",
        attempts: [
          {
            id: "logical-attempt",
            number: 1,
            startedAt: 1000,
            endedAt: 1100,
            status: "completed",
            coverage: "logical-input",
            inputState: "truncated",
            input: "Visible CLI entry input",
            outputState: "redacted",
            output: { text: "Safe visible answer · [redacted]" },
          },
        ],
      }),
    ];
    await render();
    await click(attr("data-trace-attempt", "logical-attempt"));
    expect(textOf(selectedDetail()!)).toContain("不代表 CLI 实际发送");
    expect(textOf(selectedDetail()!)).toContain("正文因存储上限被截断");
    await click(button("输出"));
    expect(textOf(selectedDetail()!)).toContain("正文已脱敏");
    expect(textOf(selectedDetail()!)).toContain("Safe visible answer · [redacted]");
  });

  test("estimates keep unknown attempts explicit and failed attempt metrics never borrow final usage", async () => {
    records[0].estimatedCostUsd = 0.002;
    records[0].unknownCostAttempts = 1;
    records[0].attempts[1].estimatedCostUsd = 0.002;
    await render();
    expect(textOf(selectedDetail()!)).toContain("~$0.002000");
    expect(textOf(selectedDetail()!)).toContain("另有 1 次尝试费用未知");
    expect(textOf(selectedDetail()!)).toContain("500 ms");
    await click(attr("data-trace-attempt", "request-a-attempt-1"));
    const metric = (label: string) =>
      textOf(
        nodes(selectedDetail()!).find((node) => node.tagName === "DT" && textOf(node) === label)!
          .parentNode!,
      );
    expect(metric("总 Token")).toBe("总 Token—");
    expect(metric("首 Token 耗时")).toBe("首 Token 耗时—");
    expect(metric("估算费用")).toBe("估算费用未记录费用");
    await click(attr("data-trace-attempt", "request-a-attempt-2"));
    expect(metric("估算费用")).toContain("~$0.002000");
    expect(metric("估算费用")).not.toContain("未知");
    expect(metric("首 Token 耗时")).toBe("首 Token 耗时200 ms");
  });

  test("unavailable conversation deep links report failure instead of silently succeeding", async () => {
    const opened: string[] = [];
    await render({
      onOpenSession: async (id) => {
        opened.push(id);
        return false;
      },
    });
    await click(button("打开原会话"));
    expect(opened).toEqual(["session-a"]);
    expect(textOf(container)).toContain("打开会话失败");
  });

  test("a failed initial list stays distinct from empty history and a refresh can recover it", async () => {
    const normal = api.list;
    api.list = async () => {
      throw new Error("Trace store unavailable");
    };
    await render();
    expect(textOf(container)).toContain("Trace store unavailable");
    expect(textOf(container)).not.toContain("还没有模型调用记录");
    api.list = normal;
    await click(button("刷新记录"));
    expect(attr("data-trace-group", "execution-a")).toBeDefined();
  });

  test("grouping keeps identical sessions in distinct executions and malformed event parents stay bounded", () => {
    expect(groupModelTraces(records.map(summary)).map((group) => group.requests.length)).toEqual([
      2, 1,
    ]);
    const base = {
      traceId: "a",
      kind: "tool" as const,
      name: "tool",
      status: "completed",
      startedAt: 0,
      inputState: "not-recorded" as const,
      outputState: "not-recorded" as const,
    };
    const events = [
      { ...base, id: "a", parentId: "b" },
      { ...base, id: "b", parentId: "a" },
    ];
    expect(eventIndent(events[0], events)).toBe(1);
    expect(eventRequestId(events[0], events, new Set(["request"]))).toBeUndefined();
    events[1].parentId = "request";
    expect(eventRequestId(events[0], events, new Set(["request"]))).toBe("request");
  });
});
