import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { UsageCacheChart } from "./UsageCacheChart";
import { HOUR_MS, type UsageTimeline, type UsageTimeRow } from "./usageTimeline";

const BASE = 1_000 * HOUR_MS;
function row(hour: number, patch: Partial<UsageTimeRow> = {}): UsageTimeRow {
  return {
    requests: 3,
    promptTokens: 10_000,
    completionTokens: 100,
    totalTokens: 10_100,
    cacheReadTokens: 9_000,
    cacheCreationTokens: 0,
    knownEstimatedCostUsd: 0,
    unknownCostRequests: 0,
    unknownUsageRequests: 0,
    provider: "anthropic",
    model: "model-a",
    purpose: "main",
    bucketStart: BASE + hour * HOUR_MS,
    ...patch,
  };
}
function timeline(rows: UsageTimeRow[]): UsageTimeline {
  return { bucketMs: HOUR_MS, offsetMs: 0, since: BASE, until: BASE + 3 * HOUR_MS + 1, rows };
}
const rows = [
  row(0),
  row(1, { cacheReadTokens: 2_500 }),
  row(1, { model: "model-b", promptTokens: 6_000, cacheReadTokens: 3_000 }),
  row(2, { model: "model-b", promptTokens: 6_000, cacheReadTokens: 3_000 }),
  row(2, { model: "aux-model", purpose: "title", promptTokens: 4_000, cacheReadTokens: 0 }),
];

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
async function mount(value: UsageTimeline) {
  ensureMiniDom();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<UsageCacheChart timeline={value} />);
    await flushMicrotasks();
  });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.parentNode?.removeChild(container);
});
const all = (predicate: (value: Record<string, any>, node: Element) => boolean) =>
  nodes(container).filter((node) => predicate(props(node), node));
const lines = () => all((value) => value["data-series-line"] !== undefined);
const legend = () => all((value) => value["data-series-toggle"] !== undefined);
const mainOnly = () => all((value) => value.role === "switch")[0]!;
const plot = () => all((value) => value["data-cache-plot"] !== undefined)[0]!;
const tooltip = () => all((value) => value["data-cache-tooltip"] !== undefined)[0];
async function fire(run: () => void) {
  await act(async () => {
    run();
    await flushMicrotasks();
  });
}

test("draws one line per model with a legend naming each", async () => {
  await mount(timeline(rows));
  expect(textOf(container)).toContain("缓存命中率走势");
  expect(lines()).toHaveLength(2);
  expect(legend().map((node) => textOf(node))).toEqual(["model-a", "model-b"]);
  expect(legend().every((node) => props(node)["aria-pressed"] === true)).toBe(true);
  // Cached and uncached input share the time axis in a second panel.
  expect(all((value) => value["data-volume"] === "cached").length).toBeGreaterThan(0);
  expect(all((value) => value["data-volume"] === "uncached").length).toBeGreaterThan(0);
});

test("the main-conversation switch defaults on and adds auxiliary calls when turned off", async () => {
  await mount(timeline(rows));
  expect(props(mainOnly())["aria-checked"]).toBe(true);
  expect(textOf(container)).toContain("仅主对话请求");
  await fire(() => props(mainOnly()).onClick());
  expect(props(mainOnly())["aria-checked"]).toBe(false);
  expect(legend().map((node) => textOf(node))).toEqual(["model-a", "model-b", "aux-model"]);
  expect(lines()).toHaveLength(3);
});

test("legend entries hide and restore a model without recolouring the others", async () => {
  await mount(timeline(rows));
  const colourOfB = props(lines()[1]!).style.stroke;
  await fire(() => props(legend()[0]!).onClick());
  expect(props(legend()[0]!)["aria-pressed"]).toBe(false);
  expect(lines()).toHaveLength(1);
  expect(props(lines()[0]!)["data-series-line"]).toBe(props(legend()[1]!)["data-series-toggle"]);
  expect(props(lines()[0]!).style.stroke).toBe(colourOfB);
  await fire(() => props(legend()[0]!).onClick());
  expect(lines()).toHaveLength(2);
});

test("keyboard focus steps through buckets and reads out every visible model", async () => {
  await mount(timeline(rows));
  expect(tooltip()).toBeUndefined();
  expect(props(plot()).tabIndex).toBe(0);
  const key = (name: string) =>
    fire(() => props(plot()).onKeyDown({ key: name, preventDefault() {} }));
  await key("Home");
  await key("ArrowRight");
  const text = textOf(tooltip()!);
  expect(text).toContain("25%");
  expect(text).toContain("50%");
  expect(text).toContain("model-b");
  expect(text).toContain("3 次请求");
  await key("End");
  expect(textOf(tooltip()!)).toContain("此时段没有请求");
  await key("Escape");
  expect(tooltip()).toBeUndefined();
});

test("pointer hover snaps to the nearest bucket", async () => {
  await mount(timeline(rows));
  const surface = all((value) => value["data-cache-hit-area"] !== undefined)[0]!;
  await fire(() =>
    props(surface).onPointerMove({
      clientX: 0,
      currentTarget: { getBoundingClientRect: () => ({ left: 0 }) },
    }),
  );
  expect(textOf(tooltip()!)).toContain("90%");
  await fire(() => props(surface).onPointerLeave());
  expect(tooltip()).toBeUndefined();
});

test("the data table is an accessible twin of the chart", async () => {
  await mount(timeline(rows));
  const details = nodes(container).find((node) => node.tagName === "DETAILS")!;
  expect(textOf(details)).toContain("查看数据表");
  expect(nodes(details).some((node) => node.tagName === "TABLE")).toBe(false);
  await fire(() => props(details).onToggle({ currentTarget: { open: true } }));
  const table = nodes(details).find((node) => node.tagName === "TABLE")!;
  const body = nodes(table).filter((node) => node.tagName === "TR");
  // Header plus the three hours that had requests; the silent hour is skipped.
  expect(body).toHaveLength(4);
  expect(textOf(body[2]!)).toContain("25%");
  expect(textOf(body[2]!)).toContain("50%");
});

test("no usable buckets shows an empty state instead of an empty plot", async () => {
  await mount(timeline([]));
  expect(textOf(container)).toContain("没有可用于计算缓存命中率的记录");
  expect(nodes(container).some((node) => node.tagName.toLowerCase() === "svg")).toBe(false);
  expect(all((value) => value.role === "switch")).toHaveLength(1);
});
