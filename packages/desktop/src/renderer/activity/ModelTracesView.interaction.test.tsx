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
    purpose: "main",
    callType: "execution",
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

function sessionPage(records: ModelTraceRecord[], query: ModelTraceListQuery) {
  const groups = new Map<string, ModelTraceRecord[]>();
  for (const item of records) {
    if (query.sessionId && item.sessionId !== query.sessionId) continue;
    if (query.traceId && item.traceId !== query.traceId) continue;
    if (query.withoutSession && item.sessionId) continue;
    if (query.callType && item.callType !== query.callType) continue;
    const key = item.sessionId ? `session:${item.sessionId}` : `trace:${item.traceId}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const items = [...groups].map(([key, calls]) => {
    const latest = [...calls].sort((a, b) => b.startedAt - a.startedAt)[0];
    return {
      key,
      ...(latest.sessionId ? { sessionId: latest.sessionId } : { traceId: latest.traceId }),
      latestRequestId: latest.id,
      latestTraceId: latest.traceId,
      startedAt: Math.min(...calls.map((item) => item.startedAt)),
      updatedAt: Math.max(...calls.map((item) => item.endedAt ?? item.startedAt)),
      callCount: calls.length,
      traceCount: new Set(calls.map((item) => item.traceId)).size,
      sources: [...new Set(calls.map((item) => item.source))],
      models: [...new Set(calls.map((item) => item.model))],
      callTypes: [...new Set(calls.map((item) => item.callType ?? "other"))],
      runningCount: calls.filter((item) => item.status === "running").length,
      failedCount: calls.filter((item) => item.status === "failed").length,
    };
  });
  return { items, total: items.length };
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
  let sessionCalls: ModelTraceListQuery[];
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
    records = [
      record("request-a", "execution-a", { startedAt: 1000, endedAt: 2500 }),
      record("request-b", "execution-a", { startedAt: 900, endedAt: 2400 }),
      record("request-c", "execution-b", { startedAt: 800, endedAt: 2300 }),
    ];
    config = { enabled: true, captureContent: false, retentionDays: 7, includeEphemeral: false };
    listCalls = [];
    sessionCalls = [];
    getCalls = [];
    api = {
      sessions: async (query = {}) => {
        sessionCalls.push(query);
        return sessionPage(records, query);
      },
      list: async (query = {}) => {
        listCalls.push(query);
        const selected = records
          .filter((item) => !query.traceId || item.traceId === query.traceId)
          .filter((item) => !query.sessionId || item.sessionId === query.sessionId)
          .filter((item) => !query.withoutSession || !item.sessionId)
          .filter((item) => !query.callType || item.callType === query.callType);
        return { items: selected.map(summary), total: selected.length };
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
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        modelTraces: api,
        listSessions: async () => [
          { id: "session-a", title: "Planning the next release" },
          { id: "session-b", title: "Reviewing the change" },
        ],
        listSessionTitles: async () => ({
          "session-a": "Planning the next release",
          "session-b": "Reviewing the change",
        }),
      },
    });
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

  test("a session owns every execution and separates calls, provider retries and linked tools", async () => {
    await render();
    expect(nodes(container).filter((node) => props(node)["data-trace-session"])).toHaveLength(1);
    expect(textOf(attr("data-trace-session", "session:session-a"))).toContain(
      "Planning the next release",
    );
    expect(nodes(container).filter((node) => props(node)["data-trace-group"])).toHaveLength(2);
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(3);
    expect(listCalls).toContainEqual({ sessionId: "session-a", limit: 100 });
    expect(listCalls.some((query) => query.traceId)).toBe(false);
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

  test("call types distinguish purposes inside one session and filter before counting groups", async () => {
    records[1].purpose = "aux_summary";
    records[1].callType = "summary";
    records[2].purpose = "title";
    records[2].callType = "title";
    await render();
    const session = attr("data-trace-session", "session:session-a");
    expect(textOf(session)).toContain("运行 Prompt");
    expect(textOf(session)).toContain("摘要 / 压缩 Prompt");
    expect(textOf(session)).toContain("标题生成 Prompt");
    expect(
      nodes(attr("data-trace-request", "request-a")).some(
        (node) => props(node)["data-trace-call-type"] === "execution",
      ),
    ).toBe(true);
    const type = nodes(container).find(
      (node) => props(node)["data-trace-type-filter"] !== undefined,
    ) as HTMLElement;
    await change(type, "summary");
    expect(sessionCalls.at(-1)).toEqual({ limit: 50, callType: "summary" });
    expect(listCalls.at(-1)).toEqual({ sessionId: "session-a", limit: 100, callType: "summary" });
    expect(nodes(container).filter((node) => props(node)["data-trace-session"])).toHaveLength(1);
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(1);
    expect(attr("data-trace-request", "request-b")).toBeDefined();
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-b");
    expect(textOf(attr("data-trace-session", "session:session-a"))).toContain("1 次模型调用");
    await change(type, "");
    expect(sessionCalls.at(-1)).toEqual({ limit: 50 });
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(3);
  });

  test("a late page for a previous call type cannot restore an incompatible prompt", async () => {
    records[1].purpose = "aux_summary";
    records[1].callType = "summary";
    records[2].purpose = "title";
    records[2].callType = "title";
    const old = deferred<Awaited<ReturnType<ModelTraceApi["list"]>>>();
    const normal = api.list;
    api.list = (query = {}) => (query.callType === "summary" ? old.promise : normal(query));
    await render();
    const type = nodes(container).find(
      (node) => props(node)["data-trace-type-filter"] !== undefined,
    ) as HTMLElement;
    await change(type, "summary");
    expect(
      selectedDetail() ? props(selectedDetail()!)["data-trace-detail-id"] : undefined,
    ).not.toBe("request-a");
    await change(type, "title");
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    await settle(() => old.resolve({ items: [summary(records[1])], total: 1 }));
    expect(attr("data-trace-request", "request-b")).toBeUndefined();
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
  });

  test("runtime snapshots, provider requests, tool inputs and message roles stay distinct", async () => {
    records[0].input!.messages = [
      { role: "system", content: "Embedded system instruction" },
      { role: "developer", content: "Embedded developer instruction" },
      { role: "user", content: "Current user request" },
      { role: "assistant", content: "Previous model answer" },
      { role: "tool", content: "Previous tool result" },
    ];
    await render();
    let detail = textOf(selectedDetail()!);
    expect(detail).toContain("运行时输入快照");
    expect(detail).toContain("用户角色消息 · user");
    expect(detail).toContain("模型历史消息 · assistant");
    expect(detail).toContain("系统指令 · system");
    expect(detail).toContain("开发者指令 · developer");
    expect(detail).toContain("工具返回 · tool");
    await click(attr("data-trace-attempt", "request-a-attempt-1"));
    detail = textOf(selectedDetail()!);
    expect(detail).toContain("实际发送请求");
    expect(detail).toContain("Final provider wire input");
    expect(detail).not.toContain("Current user request");
    await click(attr("data-trace-event", "tool-a"));
    await click(button("输入"));
    expect(textOf(selectedDetail()!)).toContain("工具输入");
    expect(textOf(selectedDetail()!)).not.toContain("System snapshot at request time");
  });

  test("speech, transcription and unknown calls have explicit types instead of generic prompts", async () => {
    records = [
      record("speech-call", "speech-run", {
        sessionId: undefined,
        source: "panel:video-studio",
        purpose: "tts",
        callType: "speech",
        input: {
          messages: [{ role: "user", content: "Read this speech text" }],
          parameters: { voice: "fixture", format: "wav" },
        },
        output: { data: { mimeType: "audio/wav", bytes: 1234 } },
        attempts: [],
      }),
      record("transcription-call", "transcription-run", {
        sessionId: undefined,
        source: "panel:job-hunt-hq",
        purpose: "interview-transcribe",
        callType: "transcription",
        input: { messages: [], parameters: { resource: "fixture-audio", mimeType: "audio/wav" } },
        output: { text: "Recognized interview words" },
        attempts: [],
      }),
      record("unknown-call", "unknown-run", {
        sessionId: undefined,
        purpose: "custom_unmapped_purpose",
        callType: "other",
        attempts: [],
      }),
    ];
    await render();
    expect(textOf(attr("data-trace-session", "trace:speech-run"))).toContain("语音合成");
    expect(textOf(attr("data-trace-session", "trace:transcription-run"))).toContain("语音转写");
    expect(textOf(attr("data-trace-session", "trace:unknown-run"))).toContain("其他调用");
    expect(textOf(selectedDetail()!)).toContain("voice");
    expect(textOf(selectedDetail()!)).toContain("媒体模型输入");
    expect(textOf(selectedDetail()!)).not.toContain("运行时输入快照");
    await click(button("输出"));
    expect(textOf(selectedDetail()!)).toContain("audio/wav");
    await change(
      nodes(container).find(
        (node) => props(node)["data-trace-type-filter"] !== undefined,
      ) as HTMLElement,
      "transcription",
    );
    expect(nodes(container).filter((node) => props(node)["data-trace-session"])).toHaveLength(1);
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("transcription-call");
    await click(button("输出"));
    expect(textOf(selectedDetail()!)).toContain("Recognized interview words");
  });

  test("Panel calls with a session join its history while independent Panel calls stay separate", async () => {
    records.push(
      record("attached-panel", "panel-execution", {
        source: "panel:video-studio",
        startedAt: 700,
      }),
      record("independent-panel", "independent-execution", {
        sessionId: undefined,
        source: "panel:job-hunt-hq",
        startedAt: 600,
      }),
      record("second-independent-panel", "second-independent-execution", {
        sessionId: undefined,
        source: "panel:job-hunt-hq",
        startedAt: 500,
      }),
    );
    await render();
    expect(nodes(container).filter((node) => props(node)["data-trace-session"])).toHaveLength(3);
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(4);
    expect(attr("data-trace-request", "attached-panel")).toBeDefined();
    expect(attr("data-trace-request", "independent-panel")).toBeUndefined();
    await click(attr("data-trace-session", "trace:independent-execution"));
    expect(listCalls.at(-1)).toEqual({
      traceId: "independent-execution",
      withoutSession: true,
      limit: 100,
    });
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(1);
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("independent-panel");
    await click(attr("data-trace-session", "trace:second-independent-execution"));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("second-independent-panel");
  });

  test("standalone calls exclude attached session calls even when their trace IDs collide", async () => {
    records.push(
      record("independent-collision", "execution-a", {
        sessionId: undefined,
        source: "panel:job-hunt-hq",
        startedAt: 700,
      }),
    );
    await render();
    expect(nodes(container).filter((node) => props(node)["data-trace-session"])).toHaveLength(2);
    expect(attr("data-trace-request", "independent-collision")).toBeUndefined();
    await click(attr("data-trace-session", "trace:execution-a"));
    expect(listCalls.at(-1)).toEqual({
      traceId: "execution-a",
      withoutSession: true,
      limit: 100,
    });
    expect(nodes(container).filter((node) => props(node)["data-trace-request"])).toHaveLength(1);
    expect(attr("data-trace-request", "request-a")).toBeUndefined();
    expect(attr("data-trace-request", "request-b")).toBeUndefined();
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("independent-collision");
  });

  test("reselecting the pending session and request does not discard their detail read", async () => {
    const pending = deferred<Awaited<ReturnType<ModelTraceApi["get"]>>>();
    const reads: string[] = [];
    const normal = api.get;
    api.get = (id) => {
      reads.push(id);
      return id === "request-a" ? pending.promise : normal(id);
    };
    await render();
    expect(selectedDetail()).toBeUndefined();
    await click(attr("data-trace-request", "request-a"));
    await click(attr("data-trace-session", "session:session-a"));
    await click(attr("data-trace-request", "request-a"));
    expect(reads).toEqual(["request-a"]);
    await settle(() => pending.resolve({ record: records[0], events: [] }));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-a");
    expect(textOf(selectedDetail()!)).toContain("System snapshot at request time");
  });

  test("missing session-title APIs retain session identity without blocking prompts", async () => {
    Reflect.deleteProperty(window.codeshell, "listSessions");
    Reflect.deleteProperty(window.codeshell, "listSessionTitles");
    await render();
    expect(textOf(attr("data-trace-session", "session:session-a"))).toContain("session-a");
    expect(textOf(selectedDetail()!)).toContain("System snapshot at request time");
  });

  test("a failed session refresh preserves the selected execution, request and prompt", async () => {
    await render();
    await click(attr("data-trace-request", "request-c"));
    api.sessions = async () => {
      throw new Error("Session index unavailable");
    };
    await click(button("刷新记录"));
    expect(textOf(container)).toContain("Session index unavailable");
    expect(attr("data-trace-session", "session:session-a")).toBeDefined();
    expect(attr("data-trace-group", "execution-a")).toBeDefined();
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    expect(textOf(selectedDetail()!)).toContain("System snapshot at request time");
  });

  test("copies the visible prompt and acknowledges only after the clipboard accepts it", async () => {
    const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const secureBefore = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    const copied = deferred<void>();
    const writes: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: (text: string) => {
            writes.push(text);
            return copied.promise;
          },
        },
      },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    try {
      await render();
      const copy = nodes(container).find(
        (node) => props(node)["aria-label"] === "复制文本 · System Prompt",
      ) as HTMLElement;
      await click(copy);
      expect(writes).toEqual(["System snapshot at request time"]);
      expect(textOf(copy)).toBe("复制文本");
      await settle(() => copied.resolve());
      expect(textOf(copy)).toBe("已复制");
    } finally {
      if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
      else Reflect.deleteProperty(globalThis, "navigator");
      if (secureBefore) Object.defineProperty(window, "isSecureContext", secureBefore);
      else Reflect.deleteProperty(window, "isSecureContext");
    }
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

  test("paginates sessions on the server and resets cursors for trimmed filters", async () => {
    const all = sessionPage(records, {});
    api.sessions = async (query = {}) => {
      sessionCalls.push(query);
      return {
        items: all.items,
        total: 3,
        ...(query.cursor ? {} : { nextCursor: "page-two" }),
      };
    };
    await render();
    await click(button("下一页"));
    expect(sessionCalls.at(-1)?.cursor).toBe("page-two");
    const search = nodes(container).find(
      (node) => props(node)["aria-label"] === "搜索模型、用途、来源或编号",
    ) as HTMLElement;
    await change(search, "  model-b  ");
    expect(sessionCalls.at(-1)).toEqual({ limit: 50, search: "model-b" });
    expect(listCalls.every((query) => query.sessionId === "session-a")).toBe(true);
  });

  test("a late call page from another session cannot replace the active session", async () => {
    records[2].sessionId = "session-b";
    const old = deferred<Awaited<ReturnType<ModelTraceApi["list"]>>>();
    const normal = api.list;
    api.list = (query = {}) => (query.sessionId === "session-a" ? old.promise : normal(query));
    await render();
    await click(attr("data-trace-session", "session:session-b"));
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    await settle(() => old.resolve({ items: [summary(records[0])], total: 2 }));
    expect(attr("data-trace-request", "request-a")).toBeUndefined();
    expect(attr("data-trace-request", "request-c")).toBeDefined();
  });

  test("call paging rejects duplicate clicks and ignores a page after changing sessions", async () => {
    records[2].sessionId = "session-b";
    const page = deferred<Awaited<ReturnType<ModelTraceApi["list"]>>>();
    api.list = async (query = {}) => {
      listCalls.push(query);
      if (query.cursor) return page.promise;
      return query.sessionId === "session-a"
        ? { items: [summary(records[0])], total: 2, nextCursor: "more-a" }
        : { items: [summary(records[2])], total: 1 };
    };
    await render();
    const more = button("加载更多调用");
    expect(more).toBeDefined();
    await settle(() => {
      props(more).onClick();
      props(more).onClick();
    });
    expect(listCalls.filter((query) => query.cursor)).toEqual([
      { sessionId: "session-a", limit: 100, cursor: "more-a" },
    ]);
    await click(attr("data-trace-session", "session:session-b"));
    await settle(() => page.resolve({ items: [summary(records[1])], total: 2 }));
    expect(attr("data-trace-request", "request-b")).toBeUndefined();
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
  });

  test("a late session search cannot restore an obsolete filter result", async () => {
    const old = deferred<Awaited<ReturnType<ModelTraceApi["sessions"]>>>();
    const normal = api.sessions;
    api.sessions = (query = {}) => (query.search === "old" ? old.promise : normal(query));
    await render();
    const search = nodes(container).find(
      (node) => props(node)["aria-label"] === "搜索模型、用途、来源或编号",
    ) as HTMLElement;
    await change(search, "old");
    await change(search, "new");
    await settle(() => old.resolve({ items: [], total: 0 }));
    expect(attr("data-trace-session", "session:session-a")).toBeDefined();
  });

  test("deep links load the exact request even when it is outside the filtered list", async () => {
    api.sessions = async () => ({ items: [], total: 0 });
    await render({ initialSessionId: "target-session", initialRequestId: "request-c" });
    expect(getCalls).toEqual(["request-c"]);
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    expect(attr("data-trace-request", "request-c")).toBeDefined();
  });

  test("an execution deep link resolves its session and shows the sibling executions", async () => {
    await render({ initialTraceId: "execution-b" });
    expect(props(selectedDetail()!)["data-trace-detail-id"]).toBe("request-c");
    expect(props(attr("data-trace-session", "session:session-a"))["aria-pressed"]).toBe(true);
    expect(attr("data-trace-group", "execution-a")).toBeDefined();
    expect(attr("data-trace-group", "execution-b")).toBeDefined();
    expect(listCalls.some((query) => query.sessionId === "session-a")).toBe(true);
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
    expect(props(attr("data-trace-session", "session:session-b"))["aria-pressed"]).toBe(true);
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
        purpose: "external",
        callType: "external",
        attempts: [
          {
            id: "logical-attempt",
            number: 1,
            startedAt: 1000,
            endedAt: 1100,
            status: "completed",
            coverage: "external-cli-input",
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
    expect(textOf(selectedDetail()!)).toContain("正文仅部分记录");
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
    const normal = api.sessions;
    api.sessions = async () => {
      throw new Error("Trace store unavailable");
    };
    await render();
    expect(textOf(container)).toContain("Trace store unavailable");
    expect(textOf(container)).not.toContain("还没有模型调用记录");
    api.sessions = normal;
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
