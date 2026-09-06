import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "./SettingsPage";
import { DialogProvider } from "../ui/DialogProvider";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

let root: Root;
let container: HTMLElement;
let storageBefore: PropertyDescriptor | undefined;

beforeEach(() => {
  ensureMiniDom();
  storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
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
  if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function render(project = false) {
  await act(async () => {
    root.render(
      <DialogProvider>
        <SettingsPage
          initialModule={project ? "project-overview" : "shortcuts"}
          initialProjectPath={project ? "/repo" : undefined}
          activeProjectPath={null}
          projects={project ? [{ id: "repo", path: "/repo", name: "repo", addedAt: 1 }] : []}
          sessionIndices={{}}
          onRestoreArchivedSession={() => undefined}
          onDeleteArchivedSession={() => undefined}
          isMac={false}
          isFullscreen={false}
          onBack={() => undefined}
        />
      </DialogProvider>,
    );
    await flushMicrotasks();
  });
}

function searchInputs(): any[] {
  return descendants(container).filter(
    (node) => node.tagName === "INPUT" && props(node).type === "search",
  );
}

async function search(value: string) {
  await act(async () => {
    props(searchInputs()[1]).onChange({ target: { value } });
    await flushMicrotasks();
  });
}

function narrowResults() {
  return descendants(container).filter((node) => node.tagName === "NAV")[1];
}

describe("SettingsPage responsive search", () => {
  test.each(["metaKey", "ctrlKey"])(
    "%s+F focuses the visible field after layout changes",
    async (modifier) => {
      await render();
      const [desktop, narrow] = searchInputs();
      let compact = true;
      desktop.getClientRects = () => (compact ? [] : [{}]);
      narrow.getClientRects = () => (compact ? [{}] : []);
      const shortcut = () => {
        const event = Object.assign(new Event("keydown", { cancelable: true }), {
          key: "F",
          [modifier]: true,
        });
        window.dispatchEvent(event);
        return event;
      };

      expect(shortcut().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(narrow);
      compact = false;
      expect(shortcut().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(desktop);
    },
  );

  test("narrow results navigate to the selected module and clear both search fields", async () => {
    await render();
    await search("外观");
    const result = narrowResults();
    const buttons = descendants(result).filter((node) => node.tagName === "BUTTON");
    expect(buttons.map(textOf)).toEqual(["外观"]);
    expect(searchInputs().map((input) => props(input).value)).toEqual(["外观", "外观"]);

    await act(async () => {
      props(buttons[0]).onClick();
      await flushMicrotasks();
    });
    expect(textOf(descendants(container).find((node) => node.tagName === "H1"))).toBe("外观");
    expect(searchInputs().map((input) => props(input).value)).toEqual(["", ""]);
    expect(narrowResults()).toBeUndefined();
  });

  test("clears an empty-result query from the narrow field and keeps its focus", async () => {
    await render();
    await search("no-such-settings-module");
    expect(textOf(narrowResults())).toContain("没有匹配的设置");
    const narrow = searchInputs()[1];
    const clear = descendants(narrow.parentNode).find(
      (node) => node.tagName === "BUTTON" && props(node)["aria-label"],
    );
    await act(async () => {
      props(clear).onClick();
      await flushMicrotasks();
    });
    expect(document.activeElement).toBe(narrow);
    expect(searchInputs().map((input) => props(input).value)).toEqual(["", ""]);
    expect(narrowResults()).toBeUndefined();
  });

  test("narrow search respects project scope restrictions", async () => {
    await render(true);
    await search("外观");
    expect(textOf(narrowResults())).toContain("没有匹配的设置");
    expect(
      descendants(narrowResults()).some(
        (node) => node.tagName === "BUTTON" && textOf(node) === "外观",
      ),
    ).toBe(false);
  });
});
