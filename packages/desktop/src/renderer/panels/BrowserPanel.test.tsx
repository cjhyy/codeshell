import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

let copyResult = true;
const copied: string[] = [];
const opened: string[] = [];
const toasts: Array<{ message: string; variant?: string }> = [];
let rejectOpen = false;
let contextMenuProps: { items: Array<{ disabled?: boolean; onClick: () => void }> } | null = null;

mock.module("../browser/useElementPicking", () => ({
  useElementPicking: () => ({
    selecting: false,
    picked: null,
    setPicked() {},
    startPicking: async () => undefined,
  }),
}));
mock.module("../browser/useIdleEvict", () => ({ useIdleEvict: () => false }));
mock.module("../browser/markerEcho", () => ({
  browserMarkersFrom: () => [],
  visibleMarkersOn: () => [],
  groupMarkersByPage: () => [],
  urlsMatch: () => false,
  useMarkerEcho: () => ({ selectorMissFor: () => false }),
}));
mock.module("../browser/WebviewHost", () => ({ WebviewHost: () => null }));
mock.module("../browser/NewTabLanding", () => ({ NewTabLanding: () => null }));
mock.module("../browser/markers", () => ({ MarkerDot: () => null }));
mock.module("../browser/ui", () => ({
  IconBtn: ({ label, onClick, disabled }: any) => (
    <button aria-label={label} disabled={disabled} onClick={onClick} />
  ),
  FloatingAt: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("../chat/CommentBox", () => ({ CommentBox: () => null }));
mock.module("../lib/clipboard", () => ({
  copyText: async (value: string) => {
    copied.push(value);
    return copyResult;
  },
}));
mock.module("../ui/ContextMenu", () => ({
  ContextMenu: (props: typeof contextMenuProps) => {
    contextMenuProps = props;
    return <div data-context-menu />;
  },
}));
mock.module("../ui/ToastProvider", () => ({
  useToast: () => (toast: { message: string; variant?: string }) => toasts.push(toast),
}));
mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

const { BrowserPanel } = await import("./BrowserPanel");

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElement(node: unknown, tagName: string): any {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (current.tagName === tagName) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

let root: Root | null = null;
let container: HTMLElement;
let initialUrl: string | undefined;
let renderKey = 0;

async function render(): Promise<void> {
  await act(async () => {
    root?.render(
      <BrowserPanel
        key={renderKey}
        cwd="/repo"
        initialUrl={initialUrl}
        showPopout={false}
      />,
    );
    await flushMicrotasks();
  });
}

beforeEach(async () => {
  ensureMiniDom();
  initialUrl = "https://committed.example/path";
  renderKey += 1;
  copyResult = true;
  rejectOpen = false;
  copied.length = 0;
  opened.length = 0;
  toasts.length = 0;
  contextMenuProps = null;
  Object.assign(window, {
    codeshell: {
      openExternal: async (url: string) => {
        opened.push(url);
        if (rejectOpen) throw new Error("OS rejected open");
      },
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  if (!root) return;
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("BrowserPanel address actions", () => {
  test("right-click copies the committed URL rather than the editable draft and reports result", async () => {
    let input = findElement(container, "INPUT");
    let props = reactPropsOf(input);
    await act(async () => {
      props.onChange({ target: { value: "https://draft.example/not-loaded" } });
      await flushMicrotasks();
    });
    input = findElement(container, "INPUT");
    props = reactPropsOf(input);
    await act(async () => {
      props.onContextMenu({
        preventDefault() {},
        metaKey: false,
        ctrlKey: false,
        clientX: 10,
        clientY: 20,
      });
      await flushMicrotasks();
    });
    expect(contextMenuProps?.items[0]?.disabled).toBe(false);
    await act(async () => {
      contextMenuProps?.items[0]?.onClick();
      await flushMicrotasks();
    });
    expect(copied).toEqual(["https://committed.example/path"]);
    expect(toasts.at(-1)).toEqual({
      message: "panels.browser.addressCopied",
      variant: "success",
    });

    copyResult = false;
    await act(async () => {
      contextMenuProps?.items[0]?.onClick();
      await flushMicrotasks();
    });
    expect(toasts.at(-1)).toEqual({
      message: "panels.browser.copyAddressFailed",
      variant: "error",
    });
  });

  test("Cmd/Ctrl opens exactly once, normal click does nothing, and rejection toasts", async () => {
    const props = reactPropsOf(findElement(container, "INPUT"));
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
    expect(toasts.at(-1)).toEqual({
      message: "panels.browser.openExternalFailed",
      variant: "error",
    });
  });

  test("NEW_TAB disables both actions and file/javascript URLs never open externally", async () => {
    initialUrl = undefined;
    renderKey += 1;
    await render();
    let props = reactPropsOf(findElement(container, "INPUT"));
    await act(async () => {
      props.onContextMenu({
        preventDefault() {},
        metaKey: false,
        ctrlKey: false,
        clientX: 1,
        clientY: 2,
      });
      await flushMicrotasks();
    });
    expect(contextMenuProps?.items.map((item) => item.disabled)).toEqual([true, true]);

    for (const url of ["file:///tmp/secret", "javascript:alert(1)"]) {
      initialUrl = url;
      renderKey += 1;
      await render();
      props = reactPropsOf(findElement(container, "INPUT"));
      props.onClick({ metaKey: true, ctrlKey: false, preventDefault() {} });
    }
    expect(opened).toEqual([]);
  });
});
