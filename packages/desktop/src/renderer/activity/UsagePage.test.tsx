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
async function mount(api: unknown) {
  ensureMiniDom();
  originalApi = window.codeshell;
  Object.assign(window, { codeshell: api });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<UsagePage />);
    await flushMicrotasks();
  });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.parentNode?.removeChild(container);
  Object.assign(window, { codeshell: originalApi });
});
const button = (label: string) =>
  nodes(container).find((node) => node.tagName === "BUTTON" && textOf(node) === label)!;

test("opening or refreshing token usage never probes a provider quota", async () => {
  let reads = 0;
  let quotaCalls = 0;
  await mount({
    getUsageSummary: async () => {
      reads++;
      return summary;
    },
    quota: {
      get: async (which: string) => {
        expect(which).toBe("both");
        quotaCalls++;
        return {
          codex: { provider: "codex", windows: [{ kind: "5h", usedPercent: 25, resetsAt: null }] },
        };
      },
    },
  });
  expect(reads).toBe(1);
  expect(quotaCalls).toBe(0);
  await act(async () => {
    props(button("刷新统计")).onClick();
    await flushMicrotasks();
  });
  expect(reads).toBe(2);
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
    quota: { get: async () => ({}) },
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
      get: async () => {
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
  expect(props(button("查询套餐额度")).disabled).toBe(false);
});
