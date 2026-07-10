import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NEW_TAB } from "../browser/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { BrowserAddressField } from "./BrowserPanel";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

let root: Root | null = null;
let container: HTMLElement;
let url = "https://committed.example/path";
let draft = url;
let copyResult = true;
let rejectOpen = false;
const copied: string[] = [];
const opened: string[] = [];
const toasts: Array<{ message: string; variant?: string }> = [];

const runtime = {
  openExternal: async (value: string) => {
    opened.push(value);
    if (rejectOpen) throw new Error("OS rejected open");
  },
  copyText: async (value: string) => {
    copied.push(value);
    return copyResult;
  },
  toast: (value: { message: string; variant?: string }) => toasts.push(value),
};

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <BrowserAddressField
        url={url}
        draft={draft}
        onDraftChange={(value) => {
          draft = value;
        }}
        onNavigate={() => undefined}
        runtime={runtime}
      />,
    );
    await flushMicrotasks();
  });
}

async function openContextMenu(): Promise<any[]> {
  const input = findElements(container, "INPUT")[0];
  await act(async () => {
    reactPropsOf(input).onContextMenu({
      preventDefault() {},
      metaKey: false,
      ctrlKey: false,
      clientX: 10,
      clientY: 20,
    });
    await flushMicrotasks();
  });
  return findElements(container, "LI");
}

beforeEach(async () => {
  ensureMiniDom();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 240 },
    offsetHeight: { configurable: true, get: () => 80 },
  });
  Object.assign(window, {
    innerWidth: 1200,
    innerHeight: 800,
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  });
  url = "https://committed.example/path";
  draft = url;
  copyResult = true;
  rejectOpen = false;
  copied.length = 0;
  opened.length = 0;
  toasts.length = 0;
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("BrowserPanel address actions", () => {
  test("right-click copies the committed URL rather than the editable draft and reports result", async () => {
    const input = findElements(container, "INPUT")[0];
    await act(async () => {
      reactPropsOf(input).onChange({ target: { value: "https://draft.example/not-loaded" } });
      await flushMicrotasks();
    });

    let items = await openContextMenu();
    await act(async () => {
      reactPropsOf(items[0]).onClick();
      await flushMicrotasks();
    });
    expect(copied).toEqual(["https://committed.example/path"]);
    expect(toasts.at(-1)?.variant).toBe("success");

    copyResult = false;
    items = await openContextMenu();
    await act(async () => {
      reactPropsOf(items[0]).onClick();
      await flushMicrotasks();
    });
    expect(toasts.at(-1)?.variant).toBe("error");
  });

  test("Cmd/Ctrl opens exactly once, normal click does nothing, and rejection toasts", async () => {
    const props = reactPropsOf(findElements(container, "INPUT")[0]);
    props.onClick({ metaKey: false, ctrlKey: false, preventDefault() {} });
    expect(opened).toEqual([]);

    await act(async () => {
      props.onClick({ metaKey: true, ctrlKey: false, preventDefault() {} });
      await flushMicrotasks();
    });
    expect(opened).toEqual(["https://committed.example/path"]);

    rejectOpen = true;
    await act(async () => {
      props.onClick({ metaKey: false, ctrlKey: true, preventDefault() {} });
      await flushMicrotasks();
    });
    expect(opened).toHaveLength(2);
    expect(toasts.at(-1)?.variant).toBe("error");
  });

  test("NEW_TAB disables both actions and file/javascript URLs never open externally", async () => {
    url = NEW_TAB;
    draft = "";
    await render();
    let items = await openContextMenu();
    reactPropsOf(items[0]).onClick();
    reactPropsOf(items[1]).onClick();
    expect(copied).toEqual([]);
    expect(opened).toEqual([]);

    for (const blocked of ["file:///tmp/secret", "javascript:alert(1)"]) {
      url = blocked;
      draft = blocked;
      await render();
      const props = reactPropsOf(findElements(container, "INPUT")[0]);
      props.onClick({ metaKey: true, ctrlKey: false, preventDefault() {} });
      items = await openContextMenu();
      reactPropsOf(items[1]).onClick();
    }
    expect(opened).toEqual([]);
  });
});
