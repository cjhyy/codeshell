import { afterEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolderTree, Globe, SquareTerminal } from "lucide-react";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelTabStrip } from "./PanelTabStrip";

let root: Root | null = null;

function reactProps(node: Element): Record<string, any> {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

async function renderStrip() {
  ensureMiniDom();
  const container = document.createElement("div");
  const closed: string[] = [];
  let opener: HTMLButtonElement | null = null;
  let restoredFocusCount = 0;
  function Harness() {
    const [tabs, setTabs] = useState([
      { id: "files-1", label: "Files", icon: FolderTree },
      { id: "browser-2", label: "Browser", icon: Globe },
      { id: "terminal-3", label: "Terminal", icon: SquareTerminal },
    ]);
    const [activeId, setActiveId] = useState("files-1");
    return (
      <>
        <button
          ref={(node) => {
            opener = node;
          }}
          type="button"
        >
          Open panel
        </button>
        <PanelTabStrip
          tabs={tabs}
          activeId={activeId}
          idPrefix="dock-a"
          hidden={false}
          label="Panel tabs"
          closeLabel="Close tab"
          onActivate={setActiveId}
          onRestoreFocus={() => {
            restoredFocusCount += 1;
            opener?.focus();
          }}
          onClose={(id) => {
            closed.push(id);
            const index = tabs.findIndex((tab) => tab.id === id);
            const remaining = tabs.filter((tab) => tab.id !== id);
            setTabs(remaining);
            if (id === activeId) setActiveId(remaining[Math.max(0, index - 1)]?.id ?? "");
          }}
        />
      </>
    );
  }
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
    await flushMicrotasks();
  });
  const tab = (id: string) =>
    descendants(container).find((node) => reactProps(node).id === `dock-a-tab-${id}`)!;
  const selected = () =>
    descendants(container).find((node) => reactProps(node)["aria-selected"] === true);
  const key = async (id: string, pressed: string, modifiers: Record<string, boolean> = {}) => {
    let prevented = false;
    await act(async () => {
      reactProps(tab(id)).onKeyDown({
        key: pressed,
        currentTarget: tab(id),
        ...modifiers,
        preventDefault() {
          prevented = true;
        },
      });
      await flushMicrotasks();
    });
    return prevented;
  };
  return {
    container,
    tab,
    selected,
    key,
    closed,
    opener: () => opener,
    restoredFocusCount: () => restoredFocusCount,
  };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("PanelTabStrip keyboard navigation", () => {
  test("moves selection and focus together, including wrapping and first/last shortcuts", async () => {
    const strip = await renderStrip();
    expect(reactProps(strip.tab("files-1")).tabIndex).toBe(0);
    expect(reactProps(strip.tab("browser-2")).tabIndex).toBe(-1);

    expect(await strip.key("files-1", "ArrowLeft")).toBe(true);
    expect(strip.selected()).toBe(strip.tab("terminal-3"));
    expect(document.activeElement).toBe(strip.tab("terminal-3"));

    await strip.key("terminal-3", "ArrowRight");
    expect(strip.selected()).toBe(strip.tab("files-1"));
    await strip.key("files-1", "End");
    expect(strip.selected()).toBe(strip.tab("terminal-3"));
    await strip.key("terminal-3", "Home");
    expect(strip.selected()).toBe(strip.tab("files-1"));
  });

  test("leaves modified navigation keys to app and operating-system shortcuts", async () => {
    const strip = await renderStrip();
    expect(await strip.key("files-1", "ArrowRight", { metaKey: true })).toBe(false);
    expect(await strip.key("files-1", "Home", { ctrlKey: true })).toBe(false);
    expect(strip.selected()).toBe(strip.tab("files-1"));
  });

  test("keeps keyboard focus on a surviving neighbour when the active tab closes", async () => {
    const strip = await renderStrip();
    await strip.key("files-1", "ArrowRight");
    expect(await strip.key("browser-2", "Delete")).toBe(true);
    expect(strip.closed).toEqual(["browser-2"]);
    expect(strip.tab("browser-2")).toBeUndefined();
    expect(strip.selected()).toBe(strip.tab("files-1"));
    expect(document.activeElement).toBe(strip.tab("files-1"));

    await strip.key("files-1", "Delete");
    expect(strip.selected()).toBe(strip.tab("terminal-3"));
    expect(document.activeElement).toBe(strip.tab("terminal-3"));
    await strip.key("terminal-3", "Delete");
    expect(strip.closed).toEqual(["browser-2", "files-1", "terminal-3"]);
    expect(strip.selected()).toBeUndefined();
    expect(document.activeElement === strip.opener()).toBe(true);
    expect(strip.restoredFocusCount()).toBe(1);
  });

  test("closing an inactive tab preserves the active tab and restores its focus", async () => {
    const strip = await renderStrip();
    const close = descendants(strip.container).find(
      (node) => reactProps(node)["aria-label"] === "Close tab: Browser",
    )!;
    (close as HTMLElement).focus();
    await act(async () => {
      reactProps(close).onClick({ currentTarget: close });
      await flushMicrotasks();
    });
    expect(strip.closed).toEqual(["browser-2"]);
    expect(strip.selected()).toBe(strip.tab("files-1"));
    expect(document.activeElement).toBe(strip.tab("files-1"));
  });

  test("closing the last tab does not steal focus from another control", async () => {
    const strip = await renderStrip();
    await strip.key("files-1", "ArrowRight");
    await strip.key("browser-2", "Delete");
    await strip.key("files-1", "Delete");
    strip.opener()!.focus();
    const close = descendants(strip.container).find(
      (node) => reactProps(node)["aria-label"] === "Close tab: Terminal",
    )!;
    await act(async () => {
      reactProps(close).onClick({ currentTarget: close });
      await flushMicrotasks();
    });
    expect(strip.selected()).toBeUndefined();
    expect(document.activeElement === strip.opener()).toBe(true);
    expect(strip.restoredFocusCount()).toBe(0);
  });
});
