import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UsageSummary } from "@cjhyy/code-shell-core";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { UsagePage } from "./UsagePage";

const summary: UsageSummary = {
  version: 1,
  scope: "store",
  includesChildren: false,
  partial: false,
  persistenceErrors: 0,
  invalidReceipts: 0,
  scannedReceipts: 0,
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  knownEstimatedCostUsd: 0,
  unknownCostRequests: 0,
  unknownUsageRequests: 0,
  byModel: [],
  bySession: [],
  byPurpose: [],
};
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
let root: Root | undefined;
let container: HTMLDivElement;
let originalApi: unknown;
async function mount(api: unknown, strict = false) {
  ensureMiniDom();
  originalApi = window.codeshell;
  Object.assign(window, { codeshell: api });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      strict ? (
        <React.StrictMode>
          <UsagePage />
        </React.StrictMode>
      ) : (
        <UsagePage />
      ),
    );
    await flushMicrotasks();
  });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.parentNode?.removeChild(container);
  Object.assign(window, { codeshell: originalApi });
});
const button = (label: string, scope: Element = container) =>
  nodes(scope).find((node) => node.tagName === "BUTTON" && textOf(node) === label)!;
const card = (id: string) =>
  nodes(container).find((node) => props(node)["data-usage-provider"] === id)!;
const codex = {
  id: "cli:codex",
  displayName: "Codex",
  source: "cli",
  quota: { supported: true, queryCost: "none" },
};
const future = {
  id: "cli:future",
  displayName: "Future Agent",
  source: "cli",
  quota: { supported: true, queryCost: "minimal-usage" },
};
const model = {
  id: "model:dsh",
  displayName: "DSH configured connection",
  source: "model-connection",
  connectionCount: 2,
  quota: { supported: false },
};
const successfulQuota = {
  provider: "codex",
  windows: [{ kind: "5h", usedPercent: 25, resetsAt: null }],
};

test("opening or refreshing token usage never probes a provider quota", async () => {
  let reads = 0;
  let quotaCalls = 0;
  let discoveries = 0;
  await mount({
    getUsageSummary: async () => {
      reads++;
      return summary;
    },
    quota: {
      listProviders: async () => {
        discoveries++;
        return [codex];
      },
      query: async (which: string) => {
        expect(which).toBe("cli:codex");
        quotaCalls++;
        return successfulQuota;
      },
    },
  });
  expect(reads).toBe(1);
  expect(discoveries).toBe(1);
  expect(quotaCalls).toBe(0);
  await act(async () => {
    props(button("刷新统计")).onClick();
    await flushMicrotasks();
  });
  expect(reads).toBe(2);
  expect(discoveries).toBe(1);
  expect(quotaCalls).toBe(0);
  await act(async () => {
    props(button("重新检测")).onClick();
    await flushMicrotasks();
  });
  expect(discoveries).toBe(2);
  expect(quotaCalls).toBe(0);
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  expect(quotaCalls).toBe(1);
  expect(textOf(container)).toContain("已使用 25%");
});

test("a late response from a previous date range cannot overwrite the current overview", async () => {
  const pending: Array<(value: UsageSummary) => void> = [];
  await mount({
    getUsageSummary: () => new Promise<UsageSummary>((resolve) => pending.push(resolve)),
    quota: { listProviders: async () => [], query: async () => ({}) },
  });
  const select = nodes(container).find((node) => node.tagName === "SELECT")!;
  await act(async () => {
    props(select).onChange({ target: { value: "all" } });
    await flushMicrotasks();
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1]!({ ...summary, totalTokens: 222 });
    await flushMicrotasks();
  });
  expect(textOf(container)).toContain("222");
  await act(async () => {
    pending[0]!({ ...summary, totalTokens: 111 });
    await flushMicrotasks();
  });
  expect(textOf(container)).not.toContain("111");
  expect(textOf(container)).toContain("222");
});

test("failed or missing quota reads stay unknown and remain retryable", async () => {
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => [codex],
      query: async () => {
        throw new Error("offline");
      },
    },
  });
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  expect(textOf(container)).toContain("没有返回可用的额度数据");
  expect(textOf(container)).not.toContain("已使用 0%");
  expect(props(button("刷新套餐额度")).disabled).toBe(false);
});

test("catalog entries drive cards and a future adapter without provider-specific UI branches", async () => {
  const queries: string[] = [];
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => [future, model],
      query: async (id: string) => {
        queries.push(id);
        return {
          provider: "future",
          windows: [{ kind: "monthly", usedPercent: 42, resetsAt: null }],
        };
      },
    },
  });
  expect(textOf(container)).not.toContain("Codex");
  expect(textOf(container)).not.toContain("Claude");
  expect(textOf(card(model.id))).toContain("已配置 2 个模型连接");
  expect(textOf(card(model.id))).toContain("暂不支持此服务商的额度查询");
  expect(nodes(card(model.id)).filter((node) => node.tagName === "BUTTON")).toHaveLength(0);
  expect(textOf(card(future.id))).toContain("1 个输出 token");
  expect(queries).toEqual([]);
  await act(async () => {
    props(button("查询套餐额度", card(future.id))).onClick();
    await flushMicrotasks();
  });
  expect(queries).toEqual([future.id]);
  expect(textOf(card(future.id))).toContain("已使用 42%");
});

test("provider queries are independent and duplicate clicks do not send a second probe", async () => {
  const queries: string[] = [];
  let finish: (value: unknown) => void = () => {};
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => [codex, future],
      query: (id: string) => {
        queries.push(id);
        return id === codex.id
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(successfulQuota);
      },
    },
  });
  await act(async () => {
    const click = props(button("查询套餐额度", card(codex.id))).onClick;
    click();
    click();
    await flushMicrotasks();
  });
  expect(queries).toEqual([codex.id]);
  expect(props(button("正在查询…", card(codex.id))).disabled).toBe(true);
  await act(async () => {
    props(button("查询套餐额度", card(future.id))).onClick();
    await flushMicrotasks();
  });
  expect(queries).toEqual([codex.id, future.id]);
  expect(textOf(card(future.id))).toContain("已使用 25%");
  await act(async () => {
    finish(successfulQuota);
    await flushMicrotasks();
  });
  expect(textOf(card(codex.id))).toContain("已使用 25%");
});

test("installed is not authenticated; an explicit missing sign-in stays unknown and retryable", async () => {
  let signedIn = false;
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => [codex],
      query: async () =>
        signedIn
          ? successfulQuota
          : { provider: "codex", errorCode: "auth-required", error: "no token" },
    },
  });
  expect(textOf(card(codex.id))).toContain("登录状态在查询时检查");
  expect(textOf(card(codex.id))).not.toContain("未找到有效");
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  expect(textOf(card(codex.id))).toContain("未找到有效的套餐登录信息");
  expect(textOf(card(codex.id))).not.toContain("已使用 0%");
  signedIn = true;
  await act(async () => {
    props(button("刷新套餐额度")).onClick();
    await flushMicrotasks();
  });
  expect(textOf(card(codex.id))).toContain("已使用 25%");
});

test("empty discovery does not invent fixed provider cards or remove recorded history", async () => {
  await mount({
    getUsageSummary: async () => ({ ...summary, totalTokens: 123 }),
    quota: {
      listProviders: async () => [],
      query: async () => {
        throw new Error("must not query");
      },
    },
  });
  expect(textOf(container)).toContain("未发现已接入的本机 CLI");
  expect(textOf(container)).toContain("123");
  expect(textOf(container)).not.toContain("Codex");
  expect(nodes(container).filter((node) => props(node)["data-usage-provider"])).toHaveLength(0);
});

test("re-detection removes disappeared providers and stale replies cannot restore their cards", async () => {
  let entries = [codex];
  let finish: (value: unknown) => void = () => {};
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => entries,
      query: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  entries = [];
  await act(async () => {
    props(button("重新检测")).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    finish(successfulQuota);
    await flushMicrotasks();
  });
  expect(card(codex.id)).toBeUndefined();
  expect(textOf(container)).not.toContain("已使用 25%");
});

test("discovery failure can retry without probing quota", async () => {
  let fail = true;
  let queries = 0;
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => {
        if (fail) throw new Error("owned discovery failure");
        return [future];
      },
      query: async () => {
        queries++;
        return successfulQuota;
      },
    },
  });
  expect(textOf(container)).toContain("检测本机服务商失败");
  fail = false;
  await act(async () => {
    props(button("重新检测")).onClick();
    await flushMicrotasks();
  });
  expect(card(future.id)).toBeTruthy();
  expect(queries).toBe(0);
});

test("StrictMode discovery replies cannot replace a newer catalog", async () => {
  const pending: Array<(providers: unknown[]) => void> = [];
  await mount(
    {
      getUsageSummary: async () => summary,
      quota: {
        listProviders: () => new Promise((resolve) => pending.push(resolve)),
        query: async () => {
          throw new Error("discovery must not query");
        },
      },
    },
    true,
  );
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1]!([future]);
    await flushMicrotasks();
  });
  await act(async () => {
    pending[0]!([codex]);
    await flushMicrotasks();
  });
  expect(card(future.id)).toBeTruthy();
  expect(card(codex.id)).toBeUndefined();
});

test("a removed and rediscovered ID never adopts the old card's pending response", async () => {
  let entries = [codex];
  const pending: Array<(value: unknown) => void> = [];
  await mount({
    getUsageSummary: async () => summary,
    quota: {
      listProviders: async () => entries,
      query: () => new Promise((resolve) => pending.push(resolve)),
    },
  });
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  entries = [];
  await act(async () => {
    props(button("重新检测")).onClick();
    await flushMicrotasks();
  });
  entries = [codex];
  await act(async () => {
    props(button("重新检测")).onClick();
    await flushMicrotasks();
  });
  await act(async () => {
    props(button("查询套餐额度")).onClick();
    await flushMicrotasks();
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    pending[1]!({ provider: "codex", windows: [{ kind: "5h", usedPercent: 60, resetsAt: null }] });
    await flushMicrotasks();
  });
  await act(async () => {
    pending[0]!(successfulQuota);
    await flushMicrotasks();
  });
  expect(textOf(card(codex.id))).toContain("已使用 60%");
  expect(textOf(card(codex.id))).not.toContain("已使用 25%");
});
