import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { LogsView } from "./LogsView";

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

describe("LogsView sources, filtering, and request recovery", () => {
  let root: Root;
  let container: HTMLElement;
  let bridgeBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let frameBefore: PropertyDescriptor | undefined;
  let cancelFrameBefore: PropertyDescriptor | undefined;
  let requests: Array<{
    bucket: string;
    limit: number;
    deferred: ReturnType<typeof deferred<string[]>>;
  }>;

  beforeEach(() => {
    ensureMiniDom();
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    frameBefore = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    cancelFrameBefore = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    requests = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        tailLog: (bucket: string, limit: number) => {
          const request = deferred<string[]>();
          requests.push({ bucket, limit, deferred: request });
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
    if (frameBefore) Object.defineProperty(globalThis, "requestAnimationFrame", frameBefore);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (cancelFrameBefore)
      Object.defineProperty(globalThis, "cancelAnimationFrame", cancelFrameBefore);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  });
  const settle = async (action: () => void) => {
    await act(async () => {
      action();
      await flushMicrotasks();
    });
  };
  const render = () => settle(() => root.render(<LogsView />));
  const all = () => descendants(container);
  const tab = (title: string) =>
    all().find((node) => props(node).role === "tab" && props(node).title === title)!;
  const panel = () => all().find((node) => props(node).role === "tabpanel")!;
  const pre = () => all().find((node) => node.tagName === "PRE")!;
  const button = (label: string) =>
    all().find(
      (node) =>
        node.tagName === "BUTTON" &&
        (props(node)["aria-label"] === label || textOf(node) === label),
    )!;
  const search = () => all().find((node) => props(node).type === "search") as HTMLInputElement;
  const select = (bucket: string) =>
    settle(() => props(tab(bucket)).onFocus({ defaultPrevented: false }));
  const click = (node: Element) => settle(() => props(node).onClick());
  const filter = (value: string) => settle(() => props(search()).onChange({ target: { value } }));

  test("links localized tabs to a keyboard-focusable log panel and preserves raw IPC bucket values", async () => {
    await render();
    expect(requests.map(({ bucket, limit }) => [bucket, limit])).toEqual([["desktop", 500]]);
    expect(textOf(container)).toContain("日志");
    expect(textOf(tab("desktop"))).toBe("桌面应用");
    expect(textOf(tab("engine"))).toBe("任务引擎");
    expect(textOf(tab("ui-ink"))).toBe("终端界面");
    expect(props(tab("desktop"))["aria-selected"]).toBe(true);
    expect(props(tab("desktop"))["aria-controls"]).toBe(props(panel()).id);
    expect(props(panel()).tabIndex).toBe(0);
    await select("engine");
    expect(requests[1].bucket).toBe("engine");
    expect(requests[1].limit).toBe(500);
    expect(props(tab("engine"))["aria-selected"]).toBe(true);
  });

  test("search is case insensitive, counts matching lines, and clearing restores focus without altering contents", async () => {
    await render();
    const lines = [
      "  ERROR: details\twith spacing",
      "ordinary line",
      `another Error ${"x".repeat(6000)}`,
    ];
    await settle(() => requests[0].deferred.resolve(lines));
    expect(textOf(pre())).toBe(lines.join("\n"));
    await filter("eRrOr");
    expect(textOf(container)).toContain("显示 2 / 3 行");
    expect(textOf(pre())).toBe([lines[0], lines[2]].join("\n"));
    await click(button("清除搜索"));
    expect(document.activeElement).toBe(search());
    expect(props(search()).value).toBe("");
    expect(textOf(pre())).toBe(lines.join("\n"));
    expect(props(button("自动换行"))["aria-pressed"]).toBe(true);
    await click(button("自动换行"));
    expect(props(button("自动换行"))["aria-pressed"]).toBe(false);
    expect(props(pre()).className).toContain("whitespace-pre");
    expect(props(pre()).className).not.toContain("whitespace-pre-wrap");
    expect(textOf(pre())).toBe(lines.join("\n"));
    expect(requests).toHaveLength(1);
  });

  test("distinguishes an empty log from no search matches", async () => {
    await render();
    await settle(() => requests[0].deferred.resolve([]));
    expect(textOf(panel())).toContain("暂无日志记录");
    expect(textOf(panel())).not.toContain("没有匹配的日志");
    await click(button("刷新"));
    await settle(() => requests[1].deferred.resolve(["entry"]));
    await filter("missing");
    expect(textOf(panel())).toContain("没有匹配的日志");
    expect(textOf(container)).toContain("显示 0 / 1 行");
    await click(descendants(panel()).find((node) => node.tagName === "BUTTON")!);
    expect(document.activeElement).toBe(search());
    expect(textOf(pre())).toBe("entry");
  });

  test("initial failures recover and the disappearing retry button hands focus to refresh", async () => {
    await render();
    await settle(() => requests[0].deferred.reject(new Error("disk unavailable")));
    expect(textOf(container)).toContain("disk unavailable");
    expect(textOf(panel())).toContain("日志暂时无法读取");
    await click(button("重试读取"));
    expect(document.activeElement).toBe(button("刷新"));
    expect(props(button("刷新"))["aria-disabled"]).toBe(true);
    expect(textOf(container)).not.toContain("disk unavailable");
    await click(button("刷新"));
    expect(requests).toHaveLength(2);
    await settle(() => requests[1].deferred.resolve(["recovered"]));
    expect(textOf(pre())).toBe("recovered");
    expect(props(button("刷新"))["aria-disabled"]).toBe(false);
  });

  test("a failed refresh preserves loaded lines and a later retry clears the error", async () => {
    await render();
    await settle(() => requests[0].deferred.resolve(["loaded"]));
    await click(button("刷新"));
    expect(textOf(pre())).toBe("loaded");
    expect(props(panel())["aria-busy"]).toBe(true);
    await settle(() => requests[1].deferred.reject(new Error("refresh unavailable")));
    expect(textOf(pre())).toBe("loaded");
    expect(textOf(container)).toContain("refresh unavailable");
    await click(button("重试读取"));
    await settle(() => requests[2].deferred.resolve(["newest"]));
    expect(textOf(pre())).toBe("newest");
    expect(textOf(container)).not.toContain("refresh unavailable");
  });

  test("A to B to A ignores old success and errors even when the bucket name matches again", async () => {
    await render();
    await select("engine");
    await select("desktop");
    expect(requests.map(({ bucket }) => bucket)).toEqual(["desktop", "engine", "desktop"]);
    await settle(() => requests[2].deferred.resolve(["current desktop"]));
    await settle(() => requests[0].deferred.resolve(["old desktop"]));
    await settle(() => requests[1].deferred.reject(new Error("old engine error")));
    expect(textOf(pre())).toBe("current desktop");
    expect(textOf(container)).not.toContain("old engine error");
    await select("ui-ink");
    expect(textOf(panel())).not.toContain("current desktop");
    expect(textOf(panel())).toContain("正在读取日志");
    expect(requests[3].bucket).toBe("ui-ink");
  });

  test("an unmounted request cannot publish into a new page", async () => {
    await render();
    await settle(() => root.unmount());
    root = createRoot(container);
    await render();
    await settle(() => requests[1].deferred.resolve(["new page"]));
    await settle(() => requests[0].deferred.reject(new Error("unmounted request")));
    expect(textOf(pre())).toBe("new page");
    expect(textOf(container)).not.toContain("unmounted request");
  });
});
