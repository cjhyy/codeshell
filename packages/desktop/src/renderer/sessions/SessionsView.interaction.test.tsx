import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionsView } from "./SessionsView";
import type { DesktopSessionSummary } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? "";
  const children = Array.from(node.childNodes);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const FIRST: DesktopSessionSummary = {
  id: "first-session",
  file: "/fixture/first.jsonl",
  size: 1024,
  createdAt: 1000,
  updatedAt: 2000,
};
const SECOND: DesktopSessionSummary = {
  ...FIRST,
  id: "second-session",
  file: "/fixture/second.jsonl",
};

describe("SessionsView editing and recovery", () => {
  let root: Root;
  let container: HTMLElement;
  let storageBefore: PropertyDescriptor | undefined;
  let codeshellBefore: PropertyDescriptor | undefined;
  let inputPrototype: object;
  let selectBefore: PropertyDescriptor | undefined;
  const selectedInputs: HTMLInputElement[] = [];
  let sessions: DesktopSessionSummary[];
  let titles: Record<string, string>;
  let readFailure: string | null;
  let reads: number;
  const renames: Array<{ id: string; title: string; result: ReturnType<typeof deferred> }> = [];
  const deletes: Array<{ id: string; result: ReturnType<typeof deferred> }> = [];

  beforeEach(() => {
    ensureMiniDom();
    inputPrototype = Object.getPrototypeOf(document.createElement("input"));
    selectBefore = Object.getOwnPropertyDescriptor(inputPrototype, "select");
    selectedInputs.length = 0;
    // MiniDOM tracks focus but omits text selection. Model this browser method
    // locally so entering an editor can also be checked without changing production code.
    Object.defineProperty(inputPrototype, "select", {
      configurable: true,
      value(this: HTMLInputElement) {
        selectedInputs.push(this);
      },
    });
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    codeshellBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    sessions = [FIRST, SECOND];
    titles = { [FIRST.id]: "Alpha review", [SECOND.id]: "Beta planning" };
    readFailure = null;
    reads = 0;
    renames.length = 0;
    deletes.length = 0;
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        listSessions: async () => {
          reads++;
          if (readFailure) throw new Error(readFailure);
          return sessions;
        },
        listSessionTitles: async () => titles,
        renameSession: (id: string, title: string) => {
          const result = deferred();
          renames.push({ id, title, result });
          return result.promise.then(() => {
            titles = { ...titles, [id]: title };
          });
        },
        deleteSession: (id: string) => {
          const result = deferred();
          deletes.push({ id, result });
          return result.promise.then(() => {
            sessions = sessions.filter((session) => session.id !== id);
          });
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
    if (selectBefore) Object.defineProperty(inputPrototype, "select", selectBefore);
    else Reflect.deleteProperty(inputPrototype, "select");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (codeshellBefore) Object.defineProperty(window, "codeshell", codeshellBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  const nodes = () => descendants(container);
  const button = (text: string, index = 0) =>
    nodes().filter((node) => node.tagName === "BUTTON" && textOf(node) === text)[
      index
    ] as HTMLButtonElement;
  const search = () =>
    nodes().find(
      (node) => node.tagName === "INPUT" && props(node).type === "search",
    ) as HTMLInputElement;
  const editor = () =>
    nodes().find((node) => node.tagName === "INPUT" && props(node)["aria-label"] === "会话标题") as
      | HTMLInputElement
      | undefined;
  const rows = () => nodes().filter((node) => node.tagName === "LI");
  const render = async (
    onNewSession?: () => void,
    notifications: Pick<
      React.ComponentProps<typeof SessionsView>,
      "onSessionRenamed" | "onSessionDeleted"
    > = {},
  ) => {
    await act(async () => {
      root.render(<SessionsView onNewSession={onNewSession} {...notifications} />);
      await flushMicrotasks();
    });
  };
  const click = async (node: HTMLElement) => {
    node.focus();
    await act(async () => {
      props(node).onClick({ currentTarget: node });
      await flushMicrotasks();
    });
    // Browsers move focus to body when React removes the focused button
    // (for example a retry action); MiniDOM does not implement that behavior.
    if (!document.body.contains(document.activeElement)) document.body.focus();
  };
  const change = async (node: Element, value: string) => {
    await act(async () => {
      props(node).onChange({ target: { value } });
      await flushMicrotasks();
    });
  };
  const key = async (value: string, composing = false, keyCode = 0) => {
    await act(async () => {
      props(editor()!).onKeyDown({
        key: value,
        nativeEvent: { isComposing: composing },
        keyCode,
        preventDefault() {},
        stopPropagation() {},
      });
      await flushMicrotasks();
    });
  };
  const finish = async (result: ReturnType<typeof deferred>, failure?: string) => {
    await act(async () => {
      if (failure) result.reject(new Error(failure));
      else result.resolve();
      await flushMicrotasks();
    });
  };

  test("searches titles and IDs, distinguishes no results, and clears back to the field", async () => {
    await render();
    expect(textOf(container)).toContain("会话历史");
    expect(button("新会话")).toBeUndefined();
    expect(rows()).toHaveLength(2);
    await change(search(), " BETA ");
    expect(rows()).toHaveLength(1);
    expect(textOf(rows()[0])).toContain(SECOND.id);
    await change(search(), "first-session");
    expect(textOf(rows()[0])).toContain("Alpha review");
    await change(search(), "missing");
    expect(rows()).toHaveLength(0);
    expect(textOf(container)).toContain("暂无匹配的会话");
    await click(button("清空搜索"));
    expect(props(search()).value).toBe("");
    expect(document.activeElement === search()).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(reads).toBe(1);
  });

  test("shows and searches durable session titles before any UI-side rename exists", async () => {
    sessions = [
      { ...FIRST, title: "持久化会话标题" },
      { ...SECOND, title: "Original title" },
    ];
    titles = { [SECOND.id]: "Renamed title" };
    await render();
    expect(textOf(rows()[0])).toContain("持久化会话标题");
    expect(textOf(rows()[1])).toContain("Renamed title");
    await change(search(), "持久化");
    expect(rows()).toHaveLength(1);
    await click(button("重命名"));
    expect(props(editor()!).value).toBe("持久化会话标题");
  });

  test("focuses editing, preserves drafts on blur and IME keys, and cancels without a write", async () => {
    await render();
    await click(button("重命名"));
    expect(document.activeElement === editor()).toBe(true);
    expect(selectedInputs.at(-1) === editor()).toBe(true);
    await change(editor()!, "未保存的草稿");
    button("保存").focus();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(renames).toHaveLength(0);
    expect(props(editor()!).value).toBe("未保存的草稿");
    editor()!.focus();
    await key("Enter", true);
    await key("Escape", true);
    await key("Enter", false, 229);
    expect(renames).toHaveLength(0);
    expect(editor()).toBeDefined();
    await key("Escape");
    expect(editor()).toBeUndefined();
    expect(document.activeElement === button("重命名")).toBe(true);
    await click(button("重命名"));
    expect(props(editor()!).value).toBe("Alpha review");
    await click(button("取消"));
    expect(renames).toHaveLength(0);
    expect(document.activeElement === button("重命名")).toBe(true);
  });

  test("clearing a renamed title restores the durable title immediately and after refresh", async () => {
    sessions = [{ ...FIRST, title: "Durable title" }];
    const notifications: Array<[string, string]> = [];
    await render(undefined, { onSessionRenamed: (id, title) => notifications.push([id, title]) });
    await click(button("重命名"));
    await change(editor()!, "");
    await key("Enter");
    expect(renames[0].title).toBe("");
    await finish(renames[0].result);
    delete titles[FIRST.id]; // The title registry removes empty overrides.
    expect(textOf(rows()[0])).toContain("Durable title");
    expect(notifications).toEqual([[FIRST.id, "Durable title"]]);
    await click(button("刷新"));
    expect(textOf(rows()[0])).toContain("Durable title");
  });

  test("deduplicates pending Enter saves and preserves a failed draft for a successful retry", async () => {
    const notifications: Array<[string, string]> = [];
    await render(undefined, { onSessionRenamed: (id, title) => notifications.push([id, title]) });
    await click(button("重命名"));
    await change(editor()!, "  Updated review  ");
    await key("Enter");
    await key("Enter");
    expect(renames).toHaveLength(1);
    expect(renames[0].id).toBe(FIRST.id);
    expect(renames[0].title).toBe("Updated review");
    expect(notifications).toEqual([]);
    expect(props(editor()!).readOnly).toBe(true);
    await finish(renames[0].result, "disk is read-only");
    expect(props(editor()!).value).toBe("  Updated review  ");
    expect(props(editor()!)["aria-invalid"]).toBe(true);
    expect(textOf(container)).toContain("标题未保存，草稿已保留：disk is read-only");
    expect(notifications).toEqual([]);
    expect(document.activeElement === editor()).toBe(true);
    await click(button("保存"));
    expect(renames).toHaveLength(2);
    await finish(renames[1].result);
    expect(editor()).toBeUndefined();
    expect(textOf(rows()[0])).toContain("Updated review");
    expect(notifications).toEqual([[FIRST.id, "Updated review"]]);
    expect(document.activeElement === button("重命名")).toBe(true);
  });

  test("returns to search when the renamed row no longer matches the filter", async () => {
    await render();
    await change(search(), "Alpha");
    await click(button("重命名"));
    await change(editor()!, "Renamed session");
    await key("Enter");
    await finish(renames[0].result);
    expect(rows()).toHaveLength(0);
    expect(document.activeElement === search()).toBe(true);
  });

  test("a completed save does not steal focus from another control", async () => {
    await render(() => undefined);
    await click(button("重命名"));
    await change(editor()!, "New title");
    await key("Enter");
    const destination = button("新会话");
    destination.focus();
    await finish(renames[0].result);
    expect(document.activeElement === destination).toBe(true);
  });

  test("shows delete failures, retries the same ID once, and focuses search after removal", async () => {
    const notifications: string[] = [];
    await render(undefined, { onSessionDeleted: (id) => notifications.push(id) });
    const remove = button("删除");
    await click(remove);
    await click(remove);
    expect(deletes).toHaveLength(1);
    expect(notifications).toEqual([]);
    await finish(deletes[0].result, "file is locked");
    expect(rows()).toHaveLength(2);
    expect(notifications).toEqual([]);
    expect(textOf(container)).toContain("删除失败：file is locked");
    await click(button("重试"));
    expect(deletes).toHaveLength(2);
    expect(deletes[1].id).toBe(FIRST.id);
    await finish(deletes[1].result);
    expect(rows()).toHaveLength(1);
    expect(notifications).toEqual([FIRST.id]);
    expect(textOf(rows()[0])).toContain(SECOND.id);
    expect(document.activeElement === search()).toBe(true);
  });

  test("retries initial and refresh read failures while preserving a loaded list", async () => {
    readFailure = "offline";
    await render();
    expect(textOf(container)).toContain("无法读取会话: offline");
    expect(textOf(container)).not.toContain("还没有会话记录");
    readFailure = null;
    await click(button("重试"));
    expect(rows()).toHaveLength(2);
    readFailure = "temporarily unavailable";
    await click(button("刷新"));
    expect(rows()).toHaveLength(2);
    expect(textOf(container)).toContain("temporarily unavailable");
    readFailure = null;
    await click(button("重试"));
    expect(textOf(container)).not.toContain("temporarily unavailable");
    expect(reads).toBe(4);
  });

  test.each(["rename", "delete"] as const)(
    "notifies the host when a pending %s succeeds after leaving the page",
    async (operation) => {
      const notifications: unknown[] = [];
      await render(undefined, {
        onSessionRenamed: (id, title) => notifications.push({ id, title }),
        onSessionDeleted: (id) => notifications.push({ id }),
      });
      if (operation === "rename") {
        await click(button("重命名"));
        await change(editor()!, "Synced title");
        await key("Enter");
      } else {
        await click(button("删除"));
      }
      await act(async () => root.render(null));
      expect(notifications).toEqual([]);
      await finish(operation === "rename" ? renames[0].result : deletes[0].result);
      expect(notifications).toEqual([
        operation === "rename" ? { id: FIRST.id, title: "Synced title" } : { id: FIRST.id },
      ]);
    },
  );
});
