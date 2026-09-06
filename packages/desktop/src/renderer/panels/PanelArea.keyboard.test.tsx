import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolderTree } from "lucide-react";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PANEL_REGISTRY, type PanelRenderContext } from "./PanelRegistry";

// Bun shares module mocks across files, and App integration suites replace both
// components. Load this suite's real instances without changing their canonical
// registrations, so these assertions and the App stubs are order-independent.
const { TopBar } = await import("../TopBar?panel-keyboard-boundaries");
const { PanelArea } = await import("./PanelArea?panel-keyboard-boundaries");

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

function reactProps(node: Element): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

describe("PanelArea keyboard boundaries", () => {
  let root: Root | null;
  let container: HTMLElement;
  let unregister: () => void;
  let codeshellDescriptor: PropertyDescriptor | undefined;
  const mounts: string[] = [];
  const unmounts: string[] = [];

  function RetainedPanel({ context }: { context: PanelRenderContext }) {
    useEffect(() => {
      mounts.push(context.tabId);
      return () => {
        unmounts.push(context.tabId);
      };
    }, [context.tabId]);
    return (
      <input
        aria-label={context.tabId}
        data-lifecycle-visible={String(context.visible)}
        data-foreground-visible={String(context.foregroundVisible)}
      />
    );
  }

  function Harness({ hidden = false, keepActiveBodyLive = false }) {
    const [tabs, setTabs] = useState([
      { id: "first", kind: "keyboard-boundary-test" },
      { id: "second", kind: "keyboard-boundary-test" },
    ]);
    const [activeId, setActiveId] = useState<string | null>("first");
    const [closed, setClosed] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <TopBar
          projectName={null}
          sessionTitle={null}
          busy={false}
          sidebarCollapsed={false}
          onToggleSidebar={() => undefined}
          panelOpen={!closed}
          onTogglePanel={() => setClosed((current) => !current)}
          panelToggleRef={toggleRef}
          statusAvailable={false}
          isMac={false}
          isFullscreen={false}
        />
        <PanelArea
          projectPath={null}
          hidden={hidden || closed}
          keepActiveBodyLive={keepActiveBodyLive}
          onClose={() => setClosed(true)}
          onRestoreFocus={() => toggleRef.current?.focus()}
          tabs={tabs}
          setTabs={setTabs}
          activeId={activeId}
          setActiveId={setActiveId}
          bucket="keyboard-test-bucket"
          requestNonce={0}
          requestKind={null}
          width={480}
          onResizeStart={() => undefined}
        />
      </>
    );
  }

  beforeEach(() => {
    ensureMiniDom();
    codeshellDescriptor = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.assign(window, { codeshell: {} });
    mounts.length = 0;
    unmounts.length = 0;
    unregister = PANEL_REGISTRY.register({
      key: "keyboard-boundary-test",
      owner: { kind: "builtin" },
      title: { kind: "literal", value: "Retained test panel" },
      icon: FolderTree,
      order: 999,
      singleton: false,
      enabled: () => true,
      render: (context) => <RetainedPanel context={context} />,
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
    root = null;
    unregister();
    if (codeshellDescriptor) Object.defineProperty(window, "codeshell", codeshellDescriptor);
    else Reflect.deleteProperty(window, "codeshell");
  });

  const render = async (hidden = false, keepActiveBodyLive = false) => {
    await act(async () => {
      root?.render(<Harness hidden={hidden} keepActiveBodyLive={keepActiveBodyLive} />);
      await flushMicrotasks();
    });
  };
  const tabs = () => descendants(container).filter((node) => node.getAttribute("role") === "tab");
  const panels = () =>
    descendants(container).filter((node) => node.getAttribute("role") === "tabpanel");
  const key = async (tab: Element, pressed: string) => {
    (tab as HTMLElement).focus();
    await act(async () => {
      reactProps(tab).onKeyDown({ key: pressed, currentTarget: tab, preventDefault() {} });
      await flushMicrotasks();
    });
  };

  test("makes inactive and hidden panels inert while retaining their bodies and live visibility", async () => {
    await render();
    const originalPanels = panels();
    const originalInputs = descendants(container).filter((node) => node.tagName === "INPUT");
    expect(originalPanels[0].getAttribute("inert")).toBeNull();
    expect(originalPanels[1].getAttribute("inert")).toBe("");
    expect(mounts).toEqual(["first", "second"]);

    await key(tabs()[0], "ArrowRight");
    expect(originalPanels[0].getAttribute("inert")).toBe("");
    expect(originalPanels[1].getAttribute("inert")).toBeNull();
    const dock = originalPanels[0].parentNode!.parentNode as HTMLElement;

    await render(true, true);
    expect(dock.getAttribute("inert")).toBe("");
    expect(dock.style.display).not.toBe("none");
    expect(originalInputs[1].getAttribute("data-lifecycle-visible")).toBe("true");
    expect(originalInputs[1].getAttribute("data-foreground-visible")).toBe("false");

    await render(true, false);
    expect(dock.getAttribute("inert")).toBe("");
    expect(dock.style.display).toBe("none");
    expect(originalInputs[1].getAttribute("data-lifecycle-visible")).toBe("false");

    await render();
    expect(dock.getAttribute("inert")).toBeNull();
    expect(panels().every((node, index) => node === originalPanels[index])).toBe(true);
    const currentInputs = descendants(container).filter((node) => node.tagName === "INPUT");
    expect(currentInputs.every((node, index) => node === originalInputs[index])).toBe(true);
    expect(mounts).toEqual(["first", "second"]);
    expect(unmounts).toEqual([]);
  });

  test("closing the focused last tab returns focus to the real TopBar panel toggle", async () => {
    await render();
    await key(tabs()[0], "Delete");
    expect(tabs()).toHaveLength(1);
    await key(tabs()[0], "Delete");
    expect(tabs()).toHaveLength(0);
    const toggle = descendants(container).find(
      (node) => node.getAttribute("data-panel-action") === "toggle",
    );
    expect(toggle).toBeDefined();
    expect(document.activeElement === toggle).toBe(true);
    expect(toggle!.getAttribute("aria-pressed")).toBe("false");
  });
});
