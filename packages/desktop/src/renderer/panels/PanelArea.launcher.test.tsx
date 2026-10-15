import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolderTree } from "lucide-react";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PANEL_REGISTRY, type PanelRenderContext } from "./PanelRegistry";
import { PANEL_LAUNCHER_KIND } from "./panelLauncherKind";
import type { OpenTab } from "./PanelArea";

// Shared shards may replace the canonical PanelArea with an App shell stub.
const { PanelArea } = await import("./PanelArea?launcher-interaction-test");
const SINGLE = "launcher-single-test";
const MULTI = "launcher-multi-test";
const INTERNAL = "launcher-internal-test";

function nodes(node: any, tag?: string): any[] {
  return [
    ...(!tag || node.tagName === tag ? [node] : []),
    ...Array.from(node.childNodes ?? []).flatMap((child) => nodes(child, tag)),
  ];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
async function click(node: any) {
  expect(node).toBeDefined();
  await act(async () => {
    props(node).onClick({ currentTarget: node, stopPropagation() {}, preventDefault() {} });
    await flushMicrotasks();
  });
}

describe("PanelArea launcher tabs", () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let descriptor: PropertyDescriptor | undefined;
  let latest: { tabs: OpenTab[]; activeId: string | null; closed: boolean };
  let unregister: Array<() => void>;
  const mounts: string[] = [];
  const unmounts: string[] = [];

  function RetainedInput({ context }: { context: PanelRenderContext }) {
    const [draft, setDraft] = useState("");
    useEffect(() => {
      mounts.push(context.tabId);
      return () => {
        unmounts.push(context.tabId);
      };
    }, [context.tabId]);
    return (
      <input
        aria-label={context.tabId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        data-visible={String(context.foregroundVisible)}
      />
    );
  }
  function Harness({ empty = false }) {
    const [tabs, setTabs] = useState<OpenTab[]>(empty ? [] : [{ id: "retained", kind: SINGLE }]);
    const [activeId, setActiveId] = useState<string | null>(empty ? null : "retained");
    const [closed, setClosed] = useState(false);
    latest = { tabs, activeId, closed };
    return (
      <PanelArea
        projectPath={null}
        bucket="launcher-test-bucket"
        hidden={closed}
        tabs={tabs}
        setTabs={setTabs}
        activeId={activeId}
        setActiveId={setActiveId}
        requestNonce={0}
        requestKind={null}
        onClose={() => setClosed(true)}
        width={480}
        onResizeStart={() => undefined}
      />
    );
  }
  const buttons = () => nodes(container, "BUTTON");
  const plus = () => buttons().find((node) => props(node)["data-panel-action"] === "new-tab");
  const card = (kind: string) =>
    buttons().find((node) => props(node)["data-panel-launcher-kind"] === kind);
  const input = () =>
    nodes(container, "INPUT").find((node) => props(node)["aria-label"] === "retained");
  const body = (kind: string) =>
    nodes(container, "DIV").find((node) => props(node)["data-panel-id"] === kind);
  const tab = (id: string) =>
    buttons().find((node) => props(node).role === "tab" && props(node).id.endsWith(`-tab-${id}`));

  beforeEach(() => {
    ensureMiniDom();
    descriptor = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(window, "codeshell", { configurable: true, value: {} });
    container = document.createElement("div");
    root = createRoot(container);
    mounts.length = 0;
    unmounts.length = 0;
    unregister = [
      [SINGLE, "Singleton panel", true, false],
      [MULTI, "Multiple panel", false, false],
      [INTERNAL, "Internal panel", true, true],
    ].map(([key, title, singleton, internalOnly]) =>
      PANEL_REGISTRY.register({
        key: key as string,
        title: { kind: "literal", value: title as string },
        owner: { kind: "builtin" },
        icon: FolderTree,
        order: 900,
        singleton: singleton as boolean,
        internalOnly: internalOnly as boolean,
        enabled: () => true,
        render: (context) => <RetainedInput context={context} />,
      }),
    );
  });
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = undefined;
    for (const dispose of unregister) dispose();
    if (descriptor) Object.defineProperty(window, "codeshell", descriptor);
    else Reflect.deleteProperty(window, "codeshell");
  });
  async function render(empty = false) {
    await act(async () => {
      root!.render(<Harness empty={empty} />);
      await flushMicrotasks();
    });
  }
  async function enterDraft() {
    await act(async () => {
      props(input()).onChange({ target: { value: "Retained user input" } });
      await flushMicrotasks();
    });
  }

  test("plus opens one closeable launcher tab, retains the input, and makes its body inert", async () => {
    await render();
    await enterDraft();
    const originalInput = input();
    const originalBody = body(SINGLE);
    await click(plus());
    const launcher = latest.tabs.find((item) => item.kind === PANEL_LAUNCHER_KIND)!;
    expect(launcher).toBeDefined();
    expect(latest.activeId).toBe(launcher.id);
    expect(latest.tabs).toHaveLength(2);
    expect(nodes(container).some((node) => props(node).role === "menu")).toBe(false);
    expect(originalBody.getAttribute("inert")).toBe("");
    expect(input()).toBe(originalInput);
    expect(props(input()).value).toBe("Retained user input");
    expect(mounts).toEqual(["retained"]);
    expect(unmounts).toEqual([]);
    await click(plus());
    expect(latest.tabs).toHaveLength(2);
    expect(latest.activeId).toBe(launcher.id);
    const close = nodes(tab(launcher.id).parentNode, "BUTTON").find(
      (node) => props(node)["aria-label"],
    );
    await click(close);
    expect(latest.tabs).toEqual([{ id: "retained", kind: SINGLE }]);
    expect(latest.activeId).toBe("retained");
    expect(originalBody.getAttribute("inert")).toBeNull();
    expect(input()).toBe(originalInput);
    expect(unmounts).toEqual([]);
  });

  test("picking a new kind replaces the launcher slot and mounts only the selected panel", async () => {
    await render();
    await enterDraft();
    const original = input();
    await click(plus());
    const launcherId = latest.activeId;
    await click(card(MULTI));
    expect(latest.tabs).toHaveLength(2);
    expect(latest.tabs[1]!.kind).toBe(MULTI);
    expect(latest.tabs[1]!.id).not.toBe(launcherId);
    expect(latest.activeId).toBe(latest.tabs[1]!.id);
    expect(latest.tabs.some((item) => item.kind === PANEL_LAUNCHER_KIND)).toBe(false);
    expect(input()).toBe(original);
    expect(props(input()).value).toBe("Retained user input");
    expect(mounts).toEqual(["retained", latest.activeId!]);
    expect(unmounts).toEqual([]);
  });

  test("picking an existing singleton focuses it and removes the launcher without duplicating it", async () => {
    await render();
    await enterDraft();
    const original = input();
    await click(plus());
    await click(card(SINGLE));
    expect(latest.tabs).toEqual([{ id: "retained", kind: SINGLE }]);
    expect(latest.activeId).toBe("retained");
    expect(input()).toBe(original);
    expect(props(input()).value).toBe("Retained user input");
    expect(mounts).toEqual(["retained"]);
    expect(unmounts).toEqual([]);
    expect(body(SINGLE).getAttribute("inert")).toBeNull();
  });

  test("launcher search filters real entries while internal-only entries stay absent", async () => {
    await render();
    await click(plus());
    expect(card(INTERNAL)).toBeUndefined();
    expect(card("subagent")).toBeUndefined();
    expect(card(SINGLE)).toBeDefined();
    expect(card(MULTI)).toBeDefined();
    const search = nodes(container, "INPUT").find((node) => props(node).type === "search");
    await act(async () => {
      props(search).onChange({ target: { value: "  MULTIPLE  " } });
      await flushMicrotasks();
    });
    expect(card(MULTI)).toBeDefined();
    expect(card(SINGLE)).toBeUndefined();
    expect(card(INTERNAL)).toBeUndefined();
  });

  test("a tools-only launcher does not advertise an empty installed-panel group", async () => {
    await render();
    await click(plus());
    expect(
      nodes(container).some((node) => props(node)["data-panel-launcher-group"] === "tools"),
    ).toBe(true);
    expect(
      nodes(container).some((node) => props(node)["data-panel-launcher-group"] === "panels"),
    ).toBe(false);
    expect(buttons().some((node) => props(node)["data-panel-launcher-window-kind"])).toBe(false);
  });

  test("the only launcher tab can be closed using the normal tab close affordance", async () => {
    await render(true);
    await click(plus());
    expect(latest.tabs).toHaveLength(1);
    expect(latest.tabs[0]!.kind).toBe(PANEL_LAUNCHER_KIND);
    const close = nodes(tab(latest.activeId!).parentNode, "BUTTON").find(
      (node) => props(node)["aria-label"],
    );
    await click(close);
    expect(latest.tabs).toHaveLength(0);
    expect(latest.closed).toBe(true);
    expect(mounts).toEqual([]);
  });

  test("tab arrow navigation and neighbor deletion keep focus in the tab strip", async () => {
    await render();
    await click(plus());
    const launcherId = latest.activeId!;
    await click(tab("retained"));
    async function key(id: string, pressed: string) {
      const node = tab(id);
      node.focus();
      await act(async () => {
        props(node).onKeyDown({ key: pressed, currentTarget: node, preventDefault() {} });
        await flushMicrotasks();
      });
    }
    await key("retained", "ArrowRight");
    expect(latest.activeId).toBe(launcherId);
    expect(document.activeElement).toBe(tab(launcherId));
    await key(launcherId, "ArrowLeft");
    expect(latest.activeId).toBe("retained");
    expect(document.activeElement).toBe(tab("retained"));
    await key("retained", "Delete");
    expect(latest.tabs).toHaveLength(1);
    expect(latest.activeId).toBe(launcherId);
    expect(document.activeElement).toBe(tab(launcherId));
  });
});
