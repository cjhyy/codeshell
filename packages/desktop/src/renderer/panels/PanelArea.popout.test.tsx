import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppWindow } from "lucide-react";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider, useToastHistory } from "../ui/ToastProvider";
import type { ToastHistoryEntry } from "../ui/toastState";
import { PANEL_REGISTRY, type PanelRenderContext } from "./PanelRegistry";

const { PanelArea } = await import("./PanelArea?panel-popout-actions");
const appDescriptorId = "panel-app:window-fixture:editor";
const appTabId = "editor-instance-2";
const bucket = "/repo::session-two";
const descendants = (node: Element): Element[] => [
  node,
  ...Array.from(node.children).flatMap(descendants),
];
const reactProps = (node: Element): Record<string, any> => {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
};
const sourceMounts: string[] = [];
const sourceUnmounts: string[] = [];
const requests: Array<{ appDescriptorId: string; tabId: string; bucket: string }> = [];
let toastHistory: ToastHistoryEntry[] = [];
let root: Root | null;
let container: HTMLElement;
let unregister: Array<() => void>;
let codeshellDescriptor: PropertyDescriptor | undefined;
let storageDescriptor: PropertyDescriptor | undefined;
let resolveOpen: () => void;
let rejectOpen: (error: Error) => void;

function RetainedPanel({ context }: { context: PanelRenderContext }) {
  useEffect(() => {
    sourceMounts.push(context.tabId);
    return () => {
      sourceUnmounts.push(context.tabId);
    };
  }, [context.tabId]);
  return <input data-source-tab={context.tabId} defaultValue="saved text" />;
}

function ToastHistoryProbe() {
  toastHistory = useToastHistory()?.history ?? [];
  return null;
}

function Harness({ activeTabId = appTabId }: { activeTabId?: string | null }) {
  const [tabs, setTabs] = useState([
    { id: appTabId, kind: appDescriptorId },
    { id: "builtin-tab", kind: "window-fixture-builtin" },
    { id: "internal-tab", kind: "window-fixture-internal" },
  ]);
  return (
    <ToastProvider>
      <ToastHistoryProbe />
      <PanelArea
        projectPath="/repo"
        bucket={bucket}
        onClose={() => {}}
        tabs={tabs}
        setTabs={setTabs}
        activeId={activeTabId}
        setActiveId={() => {}}
        requestNonce={0}
        requestKind={null}
        width={480}
        onResizeStart={() => {}}
      />
    </ToastProvider>
  );
}

beforeEach(() => {
  ensureMiniDom();
  sourceMounts.length = 0;
  sourceUnmounts.length = 0;
  requests.length = 0;
  toastHistory = [];
  codeshellDescriptor = Object.getOwnPropertyDescriptor(window, "codeshell");
  storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  Object.assign(window, {
    codeshell: {
      openPanelAppWindow: (target: (typeof requests)[number]) => {
        requests.push(target);
        return new Promise<void>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        });
      },
    },
  });
  const commonEntry = {
    title: { kind: "literal" as const, value: "Window fixture" },
    icon: AppWindow,
    order: 999,
    singleton: true,
    enabled: () => true,
    render: (context: PanelRenderContext) => <RetainedPanel context={context} />,
  };
  unregister = [
    PANEL_REGISTRY.register({
      ...commonEntry,
      key: appDescriptorId,
      owner: { kind: "panel-app", appId: "window-fixture" },
    }),
    PANEL_REGISTRY.register({
      ...commonEntry,
      key: "window-fixture-builtin",
      owner: { kind: "builtin" },
    }),
    PANEL_REGISTRY.register({
      ...commonEntry,
      key: "window-fixture-internal",
      owner: { kind: "panel-app", appId: "window-fixture" },
      internalOnly: true,
    }),
  ];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
  unregister.forEach((remove) => remove());
  if (codeshellDescriptor) Object.defineProperty(window, "codeshell", codeshellDescriptor);
  else Reflect.deleteProperty(window, "codeshell");
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const render = async (activeTabId = appTabId) => {
  await act(async () => {
    root?.render(<Harness activeTabId={activeTabId} />);
    await flushMicrotasks();
  });
};
const popout = () =>
  descendants(container).find((node) => node.getAttribute("data-panel-action") === "popout");

describe("PanelArea separate Panel App windows", () => {
  test("offers the window action only for the active installed, non-internal Panel App", async () => {
    await render("builtin-tab");
    expect(popout()).toBeUndefined();
    await render("internal-tab");
    expect(popout()).toBeUndefined();
    await render();
    const action = popout()!;
    expect(action.tagName).toBe("BUTTON");
    expect(action.getAttribute("aria-label")).toBeTruthy();
    expect(action.getAttribute("title")).toBe(action.getAttribute("aria-label"));
    expect(requests).toHaveLength(0);
  });

  test("routes the exact descriptor, tab and bucket once while preserving the source body", async () => {
    await render();
    const source = descendants(container).find(
      (node) => node.getAttribute("data-source-tab") === appTabId,
    ) as HTMLInputElement;
    source.value = "unsaved source edit";
    const action = popout()!;
    const click = reactProps(action).onClick;
    await act(async () => {
      click();
      click();
      await flushMicrotasks();
    });
    expect(requests).toEqual([{ appDescriptorId, tabId: appTabId, bucket }]);
    expect(action.getAttribute("disabled")).not.toBeNull();
    expect(action.getAttribute("aria-busy")).toBe("true");
    expect(source.value).toBe("unsaved source edit");
    expect(sourceUnmounts).toEqual([]);

    await act(async () => {
      resolveOpen();
      await flushMicrotasks();
    });
    expect(popout()!.getAttribute("disabled")).toBeNull();
    expect(popout()!.getAttribute("aria-busy")).toBeNull();
    expect(
      descendants(container).find((node) => node.getAttribute("data-source-tab") === appTabId),
    ).toBe(source);
    expect(sourceMounts.filter((id) => id === appTabId)).toHaveLength(1);
    expect(sourceUnmounts).toEqual([]);

    await act(async () => {
      reactProps(popout()!).onClick();
      await flushMicrotasks();
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      resolveOpen();
      await flushMicrotasks();
    });
  });

  test("shows a useful failure notification and makes the same source available to retry", async () => {
    await render();
    await act(async () => {
      reactProps(popout()!).onClick();
      await flushMicrotasks();
    });
    await act(async () => {
      rejectOpen(new Error("Panel project scope changed"));
      await flushMicrotasks();
    });
    expect(toastHistory).toHaveLength(1);
    expect(toastHistory[0]).toMatchObject({
      variant: "error",
      detail: "Panel project scope changed",
    });
    expect(toastHistory[0]!.message).toBeTruthy();
    expect(popout()!.getAttribute("disabled")).toBeNull();
    expect(sourceUnmounts).toEqual([]);
    await act(async () => {
      reactProps(popout()!).onClick();
      await flushMicrotasks();
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ appDescriptorId, tabId: appTabId, bucket });
    await act(async () => {
      resolveOpen();
      await flushMicrotasks();
    });
  });
});
